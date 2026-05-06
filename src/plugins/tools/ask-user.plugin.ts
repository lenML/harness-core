import type { CoreContext, AgentPlugin, ToolDef } from "../../types";

export class AskUserPlugin implements AgentPlugin {
  name = "ask-user";

  async install(ctx: CoreContext) {
    ctx.registerTool({
      definition: {
        type: "function",
        function: {
          name: "ask_user_question",
          description:
            "Ask the user a multiple-choice question to collect requirements, clarify ambiguity, or confirm a decision. " +
            "This tool will pause and wait for the user's response before continuing. " +
            "Use this tool whenever you are unsure about the user's intent or need to narrow down possibilities.",
          parameters: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description: "The question to ask the user.",
              },
              options: {
                type: "array",
                items: { type: "string" },
                description:
                  "List of options for the user to choose from. Each option should be a clear, concise description.",
              },
              allowOther: {
                type: "boolean",
                description:
                  "If true, the user may provide an answer not in the list. Default: true.",
              },
            },
            required: ["question", "options"],
          },
        },
      },
      handler: async (args) => {
        const { question, options, allowOther = true } = args;

        if (!question) return "Error: question is required.";
        if (!Array.isArray(options) || options.length === 0)
          return "Error: at least one option is required.";

        // Delegate to the UI-registered handler for the current channel
        return ctx.askUser(question, options, allowOther);
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      /**
       * AskUser is interruptible. If the user ignores the question and sends a new message,
       * it acts as an interrupt, resolving the question prompt gracefully so the agent can
       * process the new user input immediately.
       */
      interruptible: true,
    } as ToolDef);
  }
}
