/**
 * AskUserQuestion (spec 02 §提问工具 AskUserQuestion). The limits follow the Agent SDK
 * (sdk-tools:1102-1110, :3759-3766); a header counts Unicode code points, which is Tenon's reading of
 * the SDK's "max 12 chars" — JSON Schema's `maxLength` counts code points too. The executor and the
 * answer template arrive in plan step 26.
 */
import type { BuiltinTool } from './tool.js'
import { BOTH_PROFILES, noChecks } from './tool.js'

/** The input the schema below describes. */
export interface AskUserQuestionInput {
  questions: Array<{
    question: string
    header: string // ≤ 12 个 Unicode 码点
    options: Array<{ label: string; description: string }> // 2–4 个；「其他」由界面自带，不算选项
    multiSelect: boolean
  }>
}

/** What the model gets back: a subset of the SDK's AskUserQuestionOutput (sdk-tools:3749). */
export interface AskUserQuestionResult {
  answers: Record<string, string> // 键为题目原文；多选用 ", " 连接；「其他」里打的字也放在这里
  response?: string // 用户不选、直接在输入框打字时的原文；这时 answers 为 {}
}

const DESCRIPTION = [
  'Asks the user one to four multiple-choice questions and waits for the answers.',
  'Use it when the request is unclear or when a choice is the user’s to make, not to ask for permission to use a tool.',
  'Each question has a short header (at most 12 characters) and two to four options; the user can always answer in their own words instead.',
  'Set multiSelect when more than one option may apply.',
].join(' ')

export const ASK_USER_QUESTION_TOOL: BuiltinTool = {
  name: 'AskUserQuestion',
  spec: () => ({
    name: 'AskUserQuestion',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', minLength: 1, description: 'The question, in full.' },
              header: {
                type: 'string',
                minLength: 1,
                maxLength: 12,
                description: 'A short label for the question, at most 12 characters.',
              },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: {
                      type: 'string',
                      minLength: 1,
                      description: 'The option, in a few words.',
                    },
                    description: { type: 'string', description: 'What choosing it means.' },
                  },
                  required: ['label', 'description'],
                  additionalProperties: false,
                },
              },
              multiSelect: {
                type: 'boolean',
                description: 'Whether the user may choose more than one option.',
              },
            },
            required: ['question', 'header', 'options', 'multiSelect'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
  }),
  // 暂定 (§内置工具与参数, owner 2026-09-25).
  effect: 'read',
  profiles: BOTH_PROFILES,
  check: noChecks,
  texts: {},
}
