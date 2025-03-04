import { type LLMConfig } from './types';
import { logger } from './logger';
import { exec } from 'child_process';
import { promisify } from 'util';
import { DynamicToolRegistry } from './tool-registry';
import { toolSchemas } from './types/tool-schemas';

const execAsync = promisify(exec);

interface OllamaResponse {
  model: string;
  message: {
    role: string;
    content: string;
  };
}

interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface ToolResponse {
  name?: string;
  arguments?: Record<string, unknown>;
  thoughts?: string;
}

export class LLMClient {
  private config: LLMConfig;
  private toolRegistry: DynamicToolRegistry | null = null;
  private currentTool: string | null = null;
  public tools: any[] = [];
  private messages: any[] = [];
  public systemPrompt: string | null = null;
  private readonly toolSchemas: typeof toolSchemas = toolSchemas;
  private static REQUEST_TIMEOUT = 300000; // 5 minutes

  constructor(config: LLMConfig) {
    this.config = config;
    this.systemPrompt = config.systemPrompt || null;
    this.config.baseUrl = this.config.baseUrl.replace('localhost', '127.0.0.1');
    logger.debug(`Initializing Ollama client with baseURL: ${this.config.baseUrl}`);
  }

  setToolRegistry(registry: DynamicToolRegistry) {
    this.toolRegistry = registry;
    logger.debug('Tool registry set with tools:', registry.getAllTools());
  }

  public async listTools(): Promise<void> {
    logger.info('===== Available Tools =====');
    if (this.tools.length === 0) {
      logger.info('No tools available');
      return;
    }

    for (const tool of this.tools) {
      logger.info('\nTool Details:');
      logger.info(`Name: ${tool.function.name}`);
      logger.info(`Description: ${tool.function.description}`);
      if (tool.function.parameters) {
        logger.info('Parameters:');
        logger.info(JSON.stringify(tool.function.parameters, null, 2));
      }
      logger.info('------------------------');
    }
    logger.info(`Total tools available: ${this.tools.length}`);
  }

  private async testConnection(): Promise<boolean> {
    try {
      logger.debug('Testing connection to Ollama...');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${this.config.baseUrl}/api/tags`, {
        method: 'GET',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        const data = await response.json();
        logger.debug('Ollama connection test successful:', data);
        return true;
      } else {
        logger.error('Ollama connection test failed with status:', response.status);
        return false;
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          logger.error('Ollama connection test timed out after 5 seconds');
        } else {
          logger.error('Ollama connection test failed with error:', error.message);
        }
      }
      return false;
    }
  }

  private async forceKillOllama(): Promise<void> {
    try {
      logger.debug('Starting Ollama cleanup process...');
      
      try {
        logger.debug('Attempting to kill Ollama by process name...');
        const { stdout: killOutput } = await execAsync('taskkill /F /IM ollama.exe');
        logger.debug('Taskkill output:', killOutput);
      } catch (e) {
        logger.debug('No Ollama process found to kill');
      }
      
      try {
        logger.debug('Checking for processes on port 11434...');
        const { stdout } = await execAsync('netstat -ano | findstr ":11434"');
        const pids = stdout.split('\n')
          .map(line => line.trim().split(/\s+/).pop())
          .filter(pid => pid && /^\d+$/.test(pid));
        
        for (const pid of pids) {
          logger.debug(`Killing process with PID ${pid}...`);
          await execAsync(`taskkill /F /PID ${pid}`);
        }
      } catch (e) {
        logger.debug('No processes found on port 11434');
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
      logger.debug('Ollama cleanup process completed');
    } catch (error) {
      logger.error('Error during Ollama force kill:', error);
    }
  }

  private prepareMessages(): any[] {
    const formattedMessages = [];
    if (this.systemPrompt) {
      formattedMessages.push({
        role: 'system',
        content: this.systemPrompt
      });
    }

    formattedMessages.push(...this.messages);
    return formattedMessages;
  }

  async invokeWithPrompt(prompt: string) {
    logger.debug('Force killing any existing Ollama processes...');
    await this.forceKillOllama();

    logger.debug('Starting new Ollama instance...');
    const ollamaProcess = exec('ollama serve', { windowsHide: true });
    
    ollamaProcess.stdout?.on('data', (data) => {
      logger.debug('Ollama stdout:', data.toString());
    });
    
    ollamaProcess.stderr?.on('data', (data) => {
      logger.debug('Ollama stderr:', data.toString());
    });
    
    ollamaProcess.on('error', (error) => {
      logger.error('Error starting Ollama:', error);
    });
    
    ollamaProcess.unref();

    let connected = false;
    for (let i = 0; i < 10; i++) {
      logger.debug(`Waiting for Ollama to start (attempt ${i + 1}/10)...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (await this.testConnection()) {
        logger.debug('Ollama is ready and responding');
        connected = true;
        break;
      }
    }
    
    if (!connected) {
      throw new Error('Failed to start Ollama after 10 attempts');
    }

    // Detect tool using registry if available
    if (this.toolRegistry) {
      this.currentTool = this.toolRegistry.detectToolFromPrompt(prompt);
      logger.debug(`Detected tool from registry: ${this.currentTool}`);
    }

    logger.debug(`Preparing to send prompt: ${prompt}`);
    this.messages = [];
    this.messages.push({
      role: 'user',
      content: prompt
    });

    return this.invoke([]);
  }

  async invoke(toolResults: any[] = []) {
    try {
      if (toolResults.length > 0) {
        for (const result of toolResults) {
          // Convert MCP response to proper Ollama tool call format
          const toolOutput = result.output;
          try {
            const parsedOutput = JSON.parse(toolOutput);
            if (parsedOutput.content && Array.isArray(parsedOutput.content)) {
              // Extract text content from MCP response
              const content = parsedOutput.content
                .filter((item: any) => item.type === 'text')
                .map((item: any) => item.text)
                .join('\n');
              this.messages.push({
                role: 'tool',
                content,
                name: result.tool_call_id,
                tool_call_id: result.tool_call_id
              });
            } else {
              this.messages.push({
                role: 'tool',
                content: String(toolOutput),
                name: result.tool_call_id,
                tool_call_id: result.tool_call_id
              });
            }
          } catch (e) {
            // If not JSON, use as-is
            this.messages.push({
              role: 'tool',
              content: String(toolOutput),
              name: result.tool_call_id,
              tool_call_id: result.tool_call_id
            });
          }
        }
      }

      const messages = this.prepareMessages();
      const payload: any = {
        model: this.config.model,
        messages,
        stream: false,
        format: {
          type: "object",
          properties: {
            from: { 
              type: "string",
              enum: [
                "MedicationRequest",
                "Observation",
                "Patient",
                "Condition",
                "Procedure",
                "AllergyIntolerance"
              ],
              description: "Must be one of the valid FHIR resource types"
            },
            where: {
              type: "object",
              properties: {
                status: {
                  type: "string",
                  enum: ["active", "completed", "entered-in-error", "intended", "stopped", "on-hold", "unknown", "not-taken"]
                }
              },
              required: ["status"],
              if: {
                properties: { from: { const: "MedicationRequest" } }
              },
              then: {
                properties: {
                  status: { const: "active" }
                }
              },
              additionalProperties: {
                type: "string",
                pattern: "^[^http://][^https://].*$"
              }
            }
          },
          required: ["from", "where"]
        },
        options: {
          temperature: 0,  // Set to 0 for most deterministic output
          num_predict: this.config.maxTokens || 1000
        }
      };

      logger.debug('Preparing Ollama request with payload:', JSON.stringify(payload, null, 2));
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
        logger.error(`Request timed out after ${LLMClient.REQUEST_TIMEOUT/1000} seconds`);
      }, LLMClient.REQUEST_TIMEOUT);

      logger.debug('Sending request to Ollama...');
      const response = await fetch(`${this.config.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Ollama request failed:', {
          status: response.status,
          statusText: response.statusText,
          error: errorText
        });
        throw new Error(`HTTP error! status: ${response.status}, details: ${errorText}`);
      }

      logger.debug('Response received from Ollama, parsing...');
      const completion = await response.json() as OllamaResponse;
      logger.debug('Parsed response:', completion);

      let isToolCall = false;
      let toolCalls: ToolCall[] = [];
      let content: any = completion.message.content;

      // Parse the structured response
      try {
        // Handle both string and object responses
        const contentObj = typeof content === 'string' ? JSON.parse(content) : content;
        
        // Check if response matches our format
        if (contentObj.from && contentObj.where) {
          // Validate FHIR resource type
          const validResourceTypes = [
            "MedicationRequest",
            "Observation",
            "Patient",
            "Condition",
            "Procedure",
            "AllergyIntolerance"
          ];
          
          if (!validResourceTypes.includes(contentObj.from)) {
            logger.error('Invalid FHIR resource type:', contentObj.from);
            throw new Error('Invalid FHIR resource type');
          }

          // Convert to FHIR query format
          const queryParams = new URLSearchParams();
          Object.entries(contentObj.where).forEach(([key, value]) => {
            // Prevent any full URLs from being included
            if (typeof value === 'string' && (value.startsWith('http://') || value.startsWith('https://'))) {
              logger.error('Invalid parameter value - URL detected:', value);
              throw new Error('Invalid parameter value - URL detected');
            }
            queryParams.append(key, value as string);
          });
          
          isToolCall = true;
          toolCalls = [{
            id: `call-${Date.now()}`,
            function: {
              name: "query-fhir",
              arguments: JSON.stringify({
                searchParams: {
                  from: contentObj.from,
                  where: {
                    ...contentObj.where,
                    status: contentObj.from === "MedicationRequest" ? "active" : contentObj.where.status
                  }
                },
                authToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJmdWxsX25hbWUiOiJSeWFuIFppbGxpbmkiLCJwaWN0dXJlIjoiIiwiZW1haWwiOiIiLCJyb2xlIjoidXNlciIsImlzcyI6ImRvY2tlci1mYXN0ZW5oZWFsdGgiLCJzdWIiOiJyejIyNCIsImV4cCI6MTc0MTA2MjE0OCwiaWF0IjoxNzQxMDU4NTQ4fQ.-Qf2E2Z5S9c4NnCN48AWB3lNJAmmmZS0gRnordILLcA"
              })
            }
          }];
          content = "Using tool...";
          logger.debug('Parsed structured tool call:', { toolCalls });
        } else {
          logger.debug('Response does not match expected format:', contentObj);
        }
      } catch (e) {
        logger.debug('Response is not a structured tool call:', e);
      }

      const result = {
        content: typeof content === 'string' ? content : JSON.stringify(content),
        isToolCall,
        toolCalls
      };

      if (result.isToolCall) {
        this.messages.push({
          role: 'assistant',
          content: result.content,
          tool_calls: result.toolCalls?.map(call => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.function.name,
              arguments: call.function.arguments
            }
          }))
        });
      } else {
        this.messages.push({
          role: 'assistant',
          content: result.content
        });
      }

      return result;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        logger.error('Request aborted due to timeout');
        throw new Error(`Request timed out after ${LLMClient.REQUEST_TIMEOUT/1000} seconds`);
      }
      logger.error('LLM invocation failed:', error);
      throw error;
    } finally {
      logger.debug('Cleaning up Ollama process...');
      await this.forceKillOllama();
    }
  }
}