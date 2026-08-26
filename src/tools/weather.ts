// ============================================================
// weather.ts — Example tool for Phase 5
// ============================================================

export interface WeatherArgs {
  location: string;
}

export const weatherToolDefinition = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Get the current weather in a given location",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "The city and state, e.g. San Francisco, CA",
        },
      },
      required: ["location"],
    },
  },
};

/**
 * Executes the get_weather tool.
 * In a real app, this would call a weather API. Here it returns a stub.
 * @param args JSON string of arguments from the LLM
 * @returns JSON string representing the tool result
 */
export async function executeWeatherTool(args: string): Promise<string> {
  try {
    const parsed = JSON.parse(args) as WeatherArgs;
    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, 500));
    
    // Stub response
    const temp = Math.floor(Math.random() * 20) + 10; // 10-30 C
    const conditions = ["Sunny", "Partly Cloudy", "Raining", "Clear"];
    const condition = conditions[Math.floor(Math.random() * conditions.length)];
    
    return JSON.stringify({
      location: parsed.location,
      temperature_celsius: temp,
      condition,
    });
  } catch (error) {
    return JSON.stringify({ error: "Failed to parse location arguments" });
  }
}
