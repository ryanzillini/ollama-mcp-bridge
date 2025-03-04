import { spawn, ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';
import { ServerParameters } from './types';
import { logger } from './logger';

export class MCPClient {
  private process: ChildProcess | null = null;
  private stdin: Writable | null = null;
  private stdout: Readable | null = null;
  private initialized: boolean = false;
  private messageQueue: Array<{ resolve: Function; reject: Function; message: any }> = [];
  private nextMessageId: number = 1;
  private serverCapabilities?: any;
  private serverVersion?: any;
  private availableTools: Set<string> = new Set();

  constructor(private serverParams: ServerParameters) {}

  async connect(): Promise<void> {
    logger.debug("[MCP Client] Starting connection...");
    
    try {
      const spawnOptions: any = {
        stdio: ['pipe', 'pipe', 'pipe']
      };

      if (this.serverParams.allowedDirectory) {
        spawnOptions.cwd = this.serverParams.allowedDirectory;
        logger.debug(`[MCP Client] Using working directory: ${spawnOptions.cwd}`);
      }

      if (this.serverParams.env) {
        spawnOptions.env = {
          ...process.env,
          ...this.serverParams.env
        };
        logger.debug(`[MCP Client] Environment variables set: ${Object.keys(this.serverParams.env).join(', ')}`);
      }

      logger.debug(`[MCP Client] Spawning process: ${this.serverParams.command} ${this.serverParams.args?.join(' ')}`);
      
      this.process = spawn(
        this.serverParams.command,
        this.serverParams.args || [],
        spawnOptions
      );

      this.stdin = this.process.stdin;
      this.stdout = this.process.stdout;

      if (this.process.stderr) {
        this.process.stderr.on('data', (data: Buffer) => {
          logger.error(`[MCP Client] Process stderr: ${data.toString()}`);
        });
      }

      this.process.on('error', (error: Error) => {
        logger.error(`[MCP Client] Process error: ${error.message}`);
      });

      this.process.on('exit', (code: number | null) => {
        logger.info(`[MCP Client] Process exited with code ${code}`);
      });

      if (this.stdout) {
        this.stdout.on('data', (data: Buffer) => {
          logger.debug(`[MCP Client] Received raw data: ${data.toString().trim()}`);
          this.handleResponse(data);
        });
      }

      await this.initialize();
      await this.updateAvailableTools();
      logger.debug("[MCP Client] Connected successfully");
    } catch (error: any) {
      logger.error(`[MCP Client] Connection failed: ${error?.message || String(error)}`);
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    if (!this.stdin || !this.stdout) {
      throw new Error("[MCP Client] Connection not established");
    }

    logger.debug("[MCP Client] Initializing session...");

    const clientCapabilities = {
      tools: {
        call: true,
        list: true
      }
    };

    const clientInfo = {
      name: "MCPLLMBridge",
      version: "1.0.0"
    };
    
    const initMessage = {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "0.1.0",
        capabilities: clientCapabilities,
        clientInfo: clientInfo
      },
      id: this.nextMessageId++
    };

    try {
      const response = await this.sendMessage(initMessage);
      
      if (!response || typeof response.protocolVersion !== 'string') {
        throw new Error('[MCP Client] Invalid initialization response from server');
      }

      this.serverCapabilities = response.capabilities;
      this.serverVersion = response.serverInfo;
      this.initialized = true;

      await this.sendMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      logger.debug("[MCP Client] Session initialized");
      logger.debug(`[MCP Client] Server version: ${JSON.stringify(this.serverVersion)}`);
      logger.debug(`[MCP Client] Server capabilities: ${JSON.stringify(this.serverCapabilities)}`);
    } catch (error: any) {
      logger.error(`[MCP Client] Session initialization failed: ${error?.message || String(error)}`);
      throw error;
    }
  }

  private async updateAvailableTools(): Promise<void> {
    try {
      const tools = await this.getAvailableTools();
      this.availableTools = new Set(tools.map(tool => tool.name));
      logger.debug(`[MCP Client] Updated available tools: ${Array.from(this.availableTools).join(', ')}`);
    } catch (error) {
      logger.error('[MCP Client] Failed to update available tools:', error);
    }
  }

  private handleResponse(data: Buffer) {
    const messages = data.toString().split('\n').filter(line => line.trim());
    
    for (const message of messages) {
      try {
        const response = JSON.parse(message);
        logger.debug(`[MCP Client] Parsed message: ${JSON.stringify(response)}`);
        
        const pendingMessage = this.messageQueue.find(m => m.message.id === response.id);
        if (pendingMessage) {
          if (response.error) {
            logger.error(`[MCP Client] Message error: ${response.error.message}`);
            pendingMessage.reject(new Error(response.error.message));
          } else {
            logger.debug(`[MCP Client] Message success: ${JSON.stringify(response.result)}`);
            pendingMessage.resolve(response.result);
          }
          this.messageQueue = this.messageQueue.filter(m => m.message.id !== response.id);
        }
      } catch (error: any) {
        logger.error(`[MCP Client] Failed to parse response: ${error?.message || String(error)}`);
      }
    }
  }

  private async sendMessage(message: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.stdin || !this.stdout) {
        reject(new Error("[MCP Client] Connection not established"));
        return;
      }

      // Only add to message queue if it's a request (has an id)
      if (message.id !== undefined) {
        this.messageQueue.push({ resolve, reject, message });
      }
      
      const messageStr = JSON.stringify(message) + '\n';
      logger.debug(`[MCP Client] Sending message: ${messageStr.trim()}`);
      
      this.stdin.write(messageStr, (error) => {
        if (error) {
          logger.error(`[MCP Client] Failed to send message: ${error.message}`);
          reject(error);
          return;
        }
        
        // If it's a notification (no id), resolve immediately
        if (message.id === undefined) {
          resolve(undefined);
        }
      });
    });
  }

  async getAvailableTools(): Promise<any[]> {
    if (!this.initialized) {
      throw new Error("[MCP Client] Client not initialized");
    }

    logger.debug("[MCP Client] Requesting available tools");
    
    try {
      const message = {
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: this.nextMessageId++
      };

      const response = await this.sendMessage(message);
      logger.debug(`[MCP Client] Received tools: ${JSON.stringify(response)}`);
      return response.tools || [];
    } catch (error: any) {
      logger.error(`[MCP Client] Failed to get tools: ${error?.message || String(error)}`);
      throw error;
    }
  }

  async callTool(toolName: string, toolArgs: any): Promise<any> {
    if (!this.initialized) {
      throw new Error("[MCP Client] Client not initialized");
    }

    logger.debug(`[MCP Client] Calling tool '${toolName}' with args: ${JSON.stringify(toolArgs)}`);
    
    // Check if the tool exists
    if (!this.availableTools.has(toolName)) {
      logger.error(`[MCP Client] Unknown tool '${toolName}'. Available tools: ${Array.from(this.availableTools).join(', ')}`);
    }

    try {
      // Send the exact message format without transformation
      const message = {
        jsonrpc: "2.0",
        method: "tools/call",
        params: toolArgs,
        id: this.nextMessageId++
      };

      logger.debug(`[MCP Client] Sending tool call request...`);
      const response = await this.sendMessage(message);
      logger.debug(`[MCP Client] Tool call response: ${JSON.stringify(response)}`);
      return response;
    } catch (error: any) {
      logger.error(`[MCP Client] Tool call failed: ${error?.message || String(error)}`);
      throw error;
    }
  }

  async close(): Promise<void> {
    logger.debug("[MCP Client] Closing connection...");
    
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    
    this.stdin = null;
    this.stdout = null;
    this.initialized = false;
    this.availableTools.clear();
    
    logger.debug("[MCP Client] Connection closed");
  }
}