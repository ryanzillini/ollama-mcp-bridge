import { MCPClient } from './mcp-client';
import { LLMClient } from './llm-client';
import { logger } from './logger';
import { BridgeConfig, Tool } from './types';
import { DynamicToolRegistry } from './tool-registry';

export interface MCPLLMBridge {
  tools: any[];
  llmClient: LLMClient;
  initialize(): Promise<boolean>;
  processMessage(message: string): Promise<string>;
  setTools(tools: any[]): Promise<void>;
  close(): Promise<void>;
}

export class MCPLLMBridge implements MCPLLMBridge {
  private mcpClient: MCPClient;
  private toolRegistry: DynamicToolRegistry;
  public llmClient: LLMClient;
  public tools: any[] = [];

  constructor(private bridgeConfig: BridgeConfig) {
    if (!bridgeConfig.mcpServers?.fhir) {
      throw new Error('FHIR MCP server configuration is required');
    }
    // Initialize FHIR MCP client
    this.mcpClient = new MCPClient(bridgeConfig.mcpServers.fhir);
    this.llmClient = new LLMClient(bridgeConfig.llmConfig);
    this.toolRegistry = new DynamicToolRegistry();
  }

  async initialize(): Promise<boolean> {
    try {
      logger.info('Connecting to FHIR MCP server...');
      
      await this.mcpClient.connect();
      
      const mcpTools = await this.mcpClient.getAvailableTools();
      logger.info(`Received ${mcpTools.length} tools from FHIR MCP`);
      
      // Register tools
      mcpTools.forEach(tool => {
        this.toolRegistry.registerTool(tool);
        logger.debug(`Registered tool ${tool.name}`);
      });

      // Convert and add to tools list
      const convertedTools = this.convertMCPToolsToOpenAIFormat(mcpTools);
      this.tools.push(...convertedTools);

      // Set tools in LLM client
      this.llmClient.tools = this.tools;
      this.llmClient.setToolRegistry(this.toolRegistry);
      
      logger.info(`Initialized with ${this.tools.length} total tools`);
      logger.debug('Available tools:', this.tools.map(t => t.function.name).join(', '));
      
      return true;
    } catch (error: any) {
      logger.error(`Bridge initialization failed: ${error?.message || String(error)}`);
      return false;
    }
  }

  private convertMCPToolsToOpenAIFormat(mcpTools: Tool[]): any[] {
    return mcpTools.map(tool => {
      const converted = {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || `Use the ${tool.name} tool`,
          parameters: {
            type: "object",
            properties: tool.inputSchema?.properties || {},
            required: tool.inputSchema?.required || []
          }
        }
      };
      logger.debug(`Converted tool ${tool.name}:`, JSON.stringify(converted, null, 2));
      return converted;
    });
  }

  async processMessage(message: string): Promise<string> {
    try {
      const detectedTool = this.toolRegistry.detectToolFromPrompt(message);
      logger.info(`Detected tool: ${detectedTool}`);

      if (detectedTool) {
        const instructions = this.toolRegistry.getToolInstructions(detectedTool);
        if (instructions) {
          this.llmClient.systemPrompt = instructions;
          logger.debug('Using tool-specific instructions:', instructions);
        }
      }

      logger.info('Sending message to LLM...');
      let response = await this.llmClient.invokeWithPrompt(message);
      logger.info(`LLM response received, isToolCall: ${response.isToolCall}`);
      logger.debug('Raw LLM response:', JSON.stringify(response, null, 2));

      while (response.isToolCall && response.toolCalls?.length) {
        logger.info(`Processing ${response.toolCalls.length} tool calls`);
        const toolResponses = await this.handleToolCalls(response.toolCalls);
        logger.info('Tool calls completed, sending results back to LLM');
        response = await this.llmClient.invoke(toolResponses);
      }

      return response.content;
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      logger.error(`Error processing message: ${errorMsg}`);
      return `Error processing message: ${errorMsg}`;
    }
  }

  private async handleToolCalls(toolCalls: any[]): Promise<any[]> {
    const toolResponses = [];

    for (const toolCall of toolCalls) {
      try {
        const requestedName = toolCall.function.name;
        logger.debug(`[MCP] Looking up tool name: ${requestedName}`);

        logger.info(`[MCP] About to call MCP tool: ${requestedName}`);
        let toolArgs = JSON.parse(toolCall.function.arguments);
        logger.info(`[MCP] Tool arguments prepared: ${JSON.stringify(toolArgs)}`);
        
        const mcpCallPromise = this.mcpClient.callTool(requestedName, toolArgs);
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('MCP call timed out after 30 seconds')), 30000);
        });

        logger.info(`[MCP] Sending call to MCP...`);
        const result = await Promise.race([mcpCallPromise, timeoutPromise]);
        logger.info(`[MCP] Received response from MCP`);
        logger.debug(`[MCP] Tool result:`, result);
        
        toolResponses.push({
          tool_call_id: toolCall.id,
          output: typeof result === 'string' ? result : JSON.stringify(result)
        });
        
      } catch (error: any) {
        logger.error(`[MCP] Tool execution failed with error:`, error);
        toolResponses.push({
          tool_call_id: toolCall.id,
          output: `Error: ${error?.message || String(error)}`
        });
      }
    }

    return toolResponses;
  }

  async setTools(tools: any[]): Promise<void> {
    this.tools = tools;
    this.llmClient.tools = tools;
    this.toolRegistry = new DynamicToolRegistry();
    
    tools.forEach(tool => {
      if (tool.function) {
        this.toolRegistry.registerTool({
          name: tool.function.name,
          description: tool.function.description,
          inputSchema: tool.function.parameters
        });
      }
    });
  }

  async close(): Promise<void> {
    await this.mcpClient.close();
  }
}