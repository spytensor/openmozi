/**
 * Embedding Provider Abstraction for MOZI Vector Memory.
 *
 * Supports multiple embedding providers:
 * - OpenAI (text-embedding-3-small)
 * - Ollama (nomic-embed-text, local/free)
 * - MiniMax (embo-01)
 *
 * Default: Ollama (local, free, privacy-preserving)
 */

import pino from 'pino';

const logger = pino({ name: 'mozi:embeddings' });

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly providerName: string;
  readonly modelName: string;
}

export interface EmbeddingConfig {
  provider: 'openai' | 'ollama' | 'minimax' | 'none';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  dimensions?: number;
}

/**
 * Create an embedding provider from config.
 * Returns null if provider is 'none' or not configured.
 */
export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider | null {
  switch (config.provider) {
    case 'openai':
      return new OpenAIEmbedding(config);
    case 'ollama':
      return new OllamaEmbedding(config);
    case 'minimax':
      return new MiniMaxEmbedding(config);
    case 'none':
      return null;
    default:
      logger.warn({ provider: config.provider }, 'Unknown embedding provider, falling back to none');
      return null;
  }
}

// ---------------------------------------------------------------------------
// OpenAI Embedding Provider
// ---------------------------------------------------------------------------

class OpenAIEmbedding implements EmbeddingProvider {
  readonly providerName = 'openai';
  readonly modelName: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: EmbeddingConfig) {
    this.modelName = config.model ?? 'text-embedding-3-small';
    this.dimensions = config.dimensions ?? 1536;
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    if (!this.apiKey) {
      throw new Error('OpenAI embedding requires OPENAI_API_KEY');
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelName,
        input: texts,
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI embedding failed: ${response.status} ${error}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
    };

    return data.data.map(d => d.embedding);
  }
}

// ---------------------------------------------------------------------------
// Ollama Embedding Provider (local, free)
// ---------------------------------------------------------------------------

class OllamaEmbedding implements EmbeddingProvider {
  readonly providerName = 'ollama';
  readonly modelName: string;
  readonly dimensions: number;
  private readonly baseUrl: string;

  constructor(config: EmbeddingConfig) {
    this.modelName = config.model ?? 'nomic-embed-text';
    this.dimensions = config.dimensions ?? 768;
    this.baseUrl = config.baseUrl ?? 'http://localhost:11434';
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];

    // Ollama processes one text at a time
    for (const text of texts) {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.modelName,
          input: text,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Ollama embedding failed: ${response.status} ${error}`);
      }

      const data = await response.json() as {
        embeddings: number[][];
      };

      if (data.embeddings && data.embeddings.length > 0) {
        results.push(data.embeddings[0]);
      } else {
        throw new Error('Ollama returned empty embeddings');
      }
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// MiniMax Embedding Provider
// ---------------------------------------------------------------------------

class MiniMaxEmbedding implements EmbeddingProvider {
  readonly providerName = 'minimax';
  readonly modelName: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: EmbeddingConfig) {
    this.modelName = config.model ?? 'embo-01';
    this.dimensions = config.dimensions ?? 1024;
    this.apiKey = config.apiKey ?? process.env.MINIMAX_API_KEY ?? '';
    this.baseUrl = config.baseUrl ?? 'https://api.minimax.chat/v1';
    if (!this.apiKey) {
      throw new Error('MiniMax embedding requires MINIMAX_API_KEY');
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelName,
        input: texts,
        type: 'query',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`MiniMax embedding failed: ${response.status} ${error}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
    };

    return data.data.map(d => d.embedding);
  }
}
