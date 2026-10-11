import type { RegistryEntry } from "../../shared.ts";

export const cloudflare_aiProvider: RegistryEntry = {
  id: "cloudflare-ai",
  alias: "cf",
  format: "openai",
  executor: "cloudflare-ai",
  // URL is dynamic: uses accountId from credentials. The executor builds it.
  baseUrl: "https://api.cloudflare.com/client/v4/accounts",
  authType: "apikey",
  authHeader: "bearer",
  // 10K Neurons/day free: ~150 LLM responses or 500s Whisper audio — global edge.
  // #8717: omit dead ids (llama-3.3-70b-instruct, llama-3.1-8b-instruct,
  // gemma-3-12b-it, qwen2.5-coder-15b-instruct) — Workers AI returns 400/403/410.
  models: [
    { id: "@cf/mistral/mistral-7b-instruct-v0.2-lora", name: "Mistral 7B (🆓)" },
    { id: "@cf/qwen/qwen2.5-coder-32b-instruct", name: "Qwen 2.5 Coder 32B (🆓)" },
    { id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", name: "DeepSeek R1 Distill 32B (🆓)" },
    { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B (FP8 Fast 🆓 ~150 resp/day)" },
    { id: "@cf/meta/llama-3.2-3b-instruct", name: "Llama 3.2 3B (🆓)" },
    { id: "@cf/qwen/qwq-32b", name: "QwQ 32B (🆓)" },
    {
      id: "@cf/zai-org/glm-4.7-flash",
      name: "GLM 4.7 Flash (🆓)",
      contextLength: 131072,
    },
    { id: "@cf/moonshotai/kimi-k2.6", name: "Kimi K2.6 (🆓)", contextLength: 262144 },
    { id: "@cf/google/gemma-4-26b-a4b-it", name: "Gemma 4 26B (🆓)", contextLength: 262144 },
    // Context windows from each model's page under
    // https://developers.cloudflare.com/workers-ai/models/ (read 2026-10-11).
    { id: "@cf/openai/gpt-oss-120b", name: "GPT-OSS 120B (🆓)", contextLength: 128000 },
    { id: "@cf/openai/gpt-oss-20b", name: "GPT-OSS 20B (🆓)", contextLength: 128000 },
    {
      id: "@cf/meta/llama-4-scout-17b-16e-instruct",
      name: "Llama 4 Scout 17B (🆓)",
      contextLength: 131000,
    },
    { id: "@cf/qwen/qwen3-30b-a3b-fp8", name: "Qwen3 30B A3B (🆓)", contextLength: 32768 },
  ],
};
