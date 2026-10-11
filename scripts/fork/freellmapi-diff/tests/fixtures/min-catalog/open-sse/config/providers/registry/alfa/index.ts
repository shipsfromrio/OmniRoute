// Synthetic fixture: minimal OmniRoute catalog for the diff test bench.
export const alfaProvider = {
  id: "alfa",
  format: "openai",
  executor: "default",
  authType: "apikey",
  authHeader: "bearer",
  defaultContextLength: 65536,
  models: [
    { id: "alfa/modelo-um", name: "Alfa Um", contextLength: 131072 },
    { id: "alfa-2", name: "Alfa Dois", aliases: ["alfa-dois"], contextLength: 16384 },
    { id: "alfa-tres", name: "Alfa Tres" },
  ],
};
