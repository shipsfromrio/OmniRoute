// Synthetic fixture. The extensionless folder import exercises the resolver.
import { alfaProvider } from "./registry/alfa";

export const REGISTRY = {
  gemini: {
    id: "gemini",
    format: "gemini",
    executor: "default",
    authType: "apikey",
    authHeader: "x-goog-api-key",
    models: [
      { id: "gemini-x-flash", name: "Gemini X Flash", contextLength: 1048576 },
      { id: "gemini-y-pro", name: "Gemini Y Pro", contextLength: 2097152 },
    ],
  },
  alfa: alfaProvider,
  beta: {
    id: "beta",
    format: "openai",
    executor: "default",
    authType: "apikey",
    authHeader: "bearer",
    passthroughModels: true,
    models: [],
  },
};
