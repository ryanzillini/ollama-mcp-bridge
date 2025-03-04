import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const FHIR_API_BASE = process.env.FHIR_API_BASE || "https://d1e49254f6d1.ngrok.app";

// Create server instance
const server = new McpServer({
  name: "fhir",
  version: "1.0.0",
});

interface FHIRResponse {
  resourceType: string;
  entry?: Array<{
    resource: Record<string, any>;
  }>;
  total?: number;
  [key: string]: any;
}

// Helper function for making FHIR API requests
async function makeFHIRRequest(query: any, authToken: string) {
  try {
    const response = await fetch(FHIR_API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify(query)
    });

    if (!response.ok) {
      throw new Error(`FHIR request failed with status ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error making FHIR request:', error);
    throw error;
  }
}

// Register the FHIR query tool
server.tool(
  'query-fhir',
  'Query FHIR resources',
  {
    searchParams: z.object({
      from: z.string(),
      where: z.record(z.string(), z.string())
    }),
    authToken: z.string()
  },
  async ({ searchParams, authToken }: { searchParams: { from: string; where: Record<string, string> }; authToken: string }, extra: any) => {
    const result = await makeFHIRRequest({ from: searchParams.from, where: searchParams.where }, authToken) as FHIRResponse;
    
    // Format response for LLM consumption
    const formattedResponse = {
      resourceType: result.resourceType,
      count: result.total || 0,
      entries: result.entry?.map(entry => {
        const resource = entry.resource as {
          resourceType: string;
          status: string;
          medicationCodeableConcept?: { text: string };
          medicationReference?: { display: string };
          dosageInstruction?: Array<{ text: string }>;
          authoredOn?: string;
          dateWritten?: string;
        };
        return {
          type: resource.resourceType,
          status: resource.status,
          medication: resource.medicationCodeableConcept?.text || resource.medicationReference?.display,
          dosage: resource.dosageInstruction?.[0]?.text,
          date: resource.authoredOn || resource.dateWritten
        };
      }) || []
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(formattedResponse, null, 2)
        }
      ]
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("FHIR MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
}); 