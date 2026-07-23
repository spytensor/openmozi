# Provider Model Discovery

MOZI treats provider APIs as the source of available model IDs when they expose a list operation. The static catalog remains the source for reviewed capability, context, pricing, aliases, and safe defaults.

## Discovery Matrix

| Provider transport | Providers | Discovery strategy |
|---|---|---|
| OpenAI-compatible | OpenAI, OpenAI Codex, DeepSeek, Moonshot, Groq, Together, OpenRouter, xAI, Mistral, Hugging Face, Qianfan, NVIDIA, Z.AI, Synthetic, Venice, vLLM | Authenticated `GET /models`; provider failures fall back to the last-known list, then catalog/manual entry |
| Anthropic-compatible | Anthropic, MiniMax, Xiaomi | Authenticated `GET /v1/models`; MiniMax model discovery uses its OpenAI-compatible `/v1/models` root because chat uses a separate Anthropic path |
| Gemini native | Google | `GET https://generativelanguage.googleapis.com/v1beta/models`, filtered to `generateContent` models |
| Ollama native | Ollama | Local `GET /api/tags`; only auto-probed when Ollama is active, with explicit refresh available otherwise |
| AWS control plane | Bedrock | No generic HTTP discovery through the configured runtime endpoint; use catalog or manual model ID because listing requires the separately authenticated Bedrock control-plane API |
| Local CLI | Claude CLI, Codex CLI | Curated chat-role catalog when the binary and authentication are ready; `_cli-default` keeps the CLI default |
| Managed CLI only | Gemini CLI | Not a chat-role provider because no model bridge is registered |

Official protocol references: [OpenAI models](https://platform.openai.com/docs/api-reference/models), [Anthropic models](https://docs.anthropic.com/en/api/models-list), [Gemini models](https://ai.google.dev/api/models), [MiniMax models](https://platform.minimax.io/docs/api-reference/models/openai/list-models), [Ollama models](https://docs.ollama.com/api/tags), and [OpenRouter models](https://openrouter.ai/docs/api/api-reference/models/get-models).

## Runtime Contract

- API keys stay on the server. The browser only receives model IDs and metadata.
- Successful results are cached for five minutes and their IDs plus fetch time are persisted for restart-safe last-known fallback.
- A model can be selected when it is cataloged, returned by live discovery, or explicitly registered for one provider.
- Unknown live/manual models use conservative metadata: no assumed tools, vision, reasoning, pricing, or large context window.
- Invalid IDs and unregistered typos remain rejected, so discovery does not weaken routing health checks.
