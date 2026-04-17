import type { AppLanguage } from './schema.js'

export const SPEC_DOCS_ROOT = 'docs/specs'
export const SPEC_REQUIREMENTS_FILE = 'requirements.md'
export const SPEC_DESIGN_FILE = 'design.md'
export const SPEC_TASKS_FILE = 'tasks.md'

export type SpecFileSet = {
  title: string
  slug: string
  folderRelativePath: string
  requirementsPath: string
  designPath: string
  tasksPath: string
}

export type SpecSeedDocuments = {
  requirements: string
  design: string
  tasks: string
}

export type EnsureSpecDocumentsResult = SpecFileSet & {
  created: string[]
  existing: string[]
}

const normalizePathSeparators = (value: string) => value.replace(/\\/g, '/')

export const normalizeSpecSlug = (title: string) => {
  const slug = normalizePathSeparators(title)
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')

  return slug || 'untitled-spec'
}

export const buildSpecFileSet = (title: string): SpecFileSet => {
  const normalizedTitle = title.trim() || 'Untitled SPEC'
  const slug = normalizeSpecSlug(normalizedTitle)
  const folderRelativePath = `${SPEC_DOCS_ROOT}/${slug}`

  return {
    title: normalizedTitle,
    slug,
    folderRelativePath,
    requirementsPath: `${folderRelativePath}/${SPEC_REQUIREMENTS_FILE}`,
    designPath: `${folderRelativePath}/${SPEC_DESIGN_FILE}`,
    tasksPath: `${folderRelativePath}/${SPEC_TASKS_FILE}`,
  }
}

export const getSpecInitialTitle = (language: AppLanguage) =>
  language === 'en' ? 'New SPEC' : '新 SPEC'

export const getSpecToolTitle = (language: AppLanguage) =>
  language === 'en' ? 'SPEC' : 'SPEC'

export const buildSpecSeedDocuments = (
  title: string,
  language: AppLanguage,
): SpecSeedDocuments => {
  const specTitle = title.trim() || getSpecInitialTitle(language)

  if (language === 'en') {
    return {
      requirements: `# Requirements: ${specTitle}

## Goal

- Describe the user problem, target users, and the outcome that should be true after this feature ships.

## User Stories

- As a user, I want ..., so that ...

## Acceptance Criteria

- [ ] Given ..., when ..., then ...

## Out of Scope

- List decisions that should not be implemented in this SPEC.
`,
      design: `# Design: ${specTitle}

## Overview

- Summarize the proposed approach and the product flow.

## Architecture

- Frontend:
- State / schema:
- Backend / Electron:
- Persistence / migration:

## UX Notes

- Describe key screens, empty states, disabled states, and theme-sensitive surfaces.

## Risks

- List technical, data, and rollout risks.
`,
      tasks: `# Tasks: ${specTitle}

> SPEC-first rule: Do not start production code until requirements.md and design.md are reviewed and this task list is actionable.

- [ ] Confirm requirements
- [ ] Confirm design
- [ ] Write or update the narrowest proving tests
- [ ] Implement the first production slice
- [ ] Verify the touched flow
`,
    }
  }

  return {
    requirements: `# 需求：${specTitle}

## 目标

- 说明用户问题、目标用户，以及功能上线后应该达成的结果。

## 用户故事

- 作为用户，我希望……，以便……

## 验收标准

- [ ] 假如……，当……，那么……

## 不做范围

- 记录这份 SPEC 明确不实现的内容。
`,
    design: `# 设计：${specTitle}

## 总览

- 概括方案、产品流程，以及为什么这样做。

## 架构

- 前端：
- 状态 / schema：
- 后端 / Electron：
- 持久化 / 迁移：

## 体验说明

- 描述关键界面、空状态、禁用态，以及明暗主题敏感区域。

## 风险

- 列出技术、数据和发布风险。
`,
    tasks: `# 任务：${specTitle}

> SPEC-first 规则：requirements.md 和 design.md 被确认前，不要开始写生产代码；任务拆清楚后再进入实现。

- [ ] 确认需求
- [ ] 确认设计
- [ ] 编写或更新最小证明测试
- [ ] 实现第一段生产代码
- [ ] 验证触达流程
`,
  }
}

export const buildSpecChatPrompt = (
  files: SpecFileSet,
  language: AppLanguage,
) => {
  if (language === 'en') {
    return `Start a SPEC-first implementation for "${files.title}".

Use these documents as the source of truth:
- Requirements: ${files.requirementsPath}
- Design: ${files.designPath}
- Tasks: ${files.tasksPath}

Workflow:
1. Read and improve requirements.md first.
2. Then write or update design.md from those requirements.
3. Then break the implementation into tasks.md.
4. Ask for approval if requirements or design are ambiguous.
5. Do not edit production code before requirements.md and design.md are coherent and tasks.md has a clear first implementation slice.

Keep the final response plain and tell me which SPEC document needs review next.`
  }

  return `为“${files.title}”启动 SPEC 先行落地。

以下文档是唯一事实来源：
- 需求：${files.requirementsPath}
- 设计：${files.designPath}
- 任务：${files.tasksPath}

工作流：
1. 先阅读并完善 requirements.md。
2. 再基于需求编写或更新 design.md。
3. 然后把实现拆进 tasks.md。
4. 如果需求或设计不清楚，先问用户确认。
5. requirements.md 和 design.md 没有清晰闭环、tasks.md 没有明确第一段实现任务之前，不要编辑生产代码。

最终回复要说人话，并告诉我下一步该 review 哪份 SPEC 文档。`
}
