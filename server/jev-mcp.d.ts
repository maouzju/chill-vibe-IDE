export declare const jevKeyFileEnvKey: 'CHILL_VIBE_JEV_KEY_FILE'
export declare const jevRootEnvKey: 'CHILL_VIBE_JEV_ROOT'

export type JevQuestion = {
  type: 'noul' | 'choice' | 'score'
  instructions: string
  criteria?: Record<string, string> | string[]
}

export type JevAskArgs = {
  questions: Record<string, JevQuestion>
  paths?: string[]
  extensions?: string[]
  texts?: string[]
  threshold?: number
}

export type JevAskResult = {
  results: Record<string, Record<string, unknown>>
  unsure: string[]
  errors?: string[]
  note?: string
}

export type JevEndpoint = { provider: 'openrouter' | 'typesafe'; url: string; model: string }

export declare const jevMcpToolDefinitions: Array<{
  name: string
  description: string
  inputSchema: Record<string, unknown>
}>

export declare const resolveJevEndpoint: (apiKey: string) => JevEndpoint

export declare const compactJevAnswer: (answer: Record<string, unknown>, threshold?: number) => unknown

export declare const collectJevItems: (
  root: string,
  options?: { paths?: string[]; texts?: string[]; extensions?: string[] },
) => Promise<{ items: Array<{ label: string; state: string }>; skipped: string[] }>

export declare const runJevAsk: (
  args: JevAskArgs,
  options: {
    apiKey: string
    root: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchImpl?: (url: string, init: any) => Promise<Response>
  },
) => Promise<JevAskResult>
