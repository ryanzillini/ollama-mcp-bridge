import fs from 'fs/promises';
import path from 'path';
import { logger } from './logger';
import { ServerParameters } from './types';

export interface BridgeConfigFile {
  mcpServers: {
    [key: string]: ServerParameters;
  };
  llm?: {
    model: string;
    baseUrl: string;
    stream: boolean;
  };
  systemPrompt?: string;
}

const DEFAULT_CONFIG: BridgeConfigFile = {
  mcpServers: {
    fhir: {
      command: "node",
      args: ["./src/fhir-mcp/dist/index.js"],
      env: {
        "FHIR_API_BASE": "https://d1e49254f6d1.ngrok.app",
        "FHIR_AUTH_TOKEN": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJmdWxsX25hbWUiOiJSeWFuIFppbGxpbmkiLCJwaWN0dXJlIjoiIiwiZW1haWwiOiIiLCJyb2xlIjoidXNlciIsImlzcyI6ImRvY2tlci1mYXN0ZW5oZWFsdGgiLCJzdWIiOiJyejIyNCIsImV4cCI6MTc0MTA2MjE0OCwiaWF0IjoxNzQxMDU4NTQ4fQ.-Qf2E2Z5S9c4NnCN48AWB3lNJAmmmZS0gRnordILLcA"
      }
    }
  },
  llm: {
    model: "llama3.2:8b",
    baseUrl: "http://z.tigerpanda.tv",
    stream: false
  },
  systemPrompt: "You are an AI assistant that translates natural language requests into structured JSON queries for retrieving healthcare data from FHIR resources.\n\nYou MUST respond with ONLY a valid JSON object in this EXACT format:\n{\n  \"from\": \"[RESOURCE_TYPE]\",\n  \"where\": {\n    \"key1\": \"value1\",\n    \"key2\": \"value2\"\n  }\n}\n\nValid FHIR Resource Types:\n- MedicationRequest (for medications)\n- Observation (for vital signs and lab results)\n- Patient (for demographics)\n- Condition (for diagnoses)\n- Procedure (for procedures)\n- AllergyIntolerance (for allergies)\n\nCritical Rules:\n1. The response MUST be a single valid JSON object\n2. NO additional text before or after the JSON\n3. The \"from\" value MUST be one of the valid FHIR resource types listed above\n4. The \"where\" object MUST contain valid FHIR search parameters\n5. ALWAYS include \"patient\": \"example\" in the where clause\n6. NEVER include full URLs in parameter values\n7. NEVER try to access external websites\n\nExamples:\n\n1. Active Medications:\n{\n  \"from\": \"MedicationRequest\",\n  \"where\": {\n    \"patient\": \"example\",\n    \"status\": \"active\"\n  }\n}\n\n2. Vital Signs:\n{\n  \"from\": \"Observation\",\n  \"where\": {\n    \"patient\": \"example\",\n    \"category\": \"vital-signs\"\n  }\n}\n\n3. Patient Demographics:\n{\n  \"from\": \"Patient\",\n  \"where\": {\n    \"id\": \"example\"\n  }\n}"
};

export async function loadBridgeConfig(): Promise<BridgeConfigFile> {
  const projectDir = path.resolve(__dirname, '..');
  const configPath = path.join(projectDir, 'bridge_config.json');
  
  try {
    const configData = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configData);
    logger.info(`Loaded bridge configuration from ${configPath}`);

    return {
      ...DEFAULT_CONFIG,
      ...config,
      mcpServers: {
        ...DEFAULT_CONFIG.mcpServers,
        ...config.mcpServers
      },
      llm: {
        ...DEFAULT_CONFIG.llm,
        ...config.llm
      }
    };
  } catch (error: any) {
    logger.warn(`Could not load bridge_config.json from ${configPath}, using defaults`);
    return DEFAULT_CONFIG;
  }
}