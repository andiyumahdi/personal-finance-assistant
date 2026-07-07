// Provider abstraction so the underlying AI vendor (currently Gemini) can be
// swapped later without touching domain logic. See docs/SPECIFICATION.md
// section 1.5 (vendor lock mitigation).

export const aiProvider = {
  async extract(rawText, context) {
    // TODO: call extractionPrompt + geminiClient, validate against JSON schema
    // TODO: retry once on schema validation failure (see spec 11.2)
  },

  async generateReply(intent, data) {
    // TODO: call personaPrompt + geminiClient
  },
};
