/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * AskUserQuestion tool — AI agent 主动向用户提问并等待回答。
 *
 * 流程：
 * 1. AI 调用 AskUserQuestion 工具，传入问题和选项
 * 2. 发送 form 交互式飞书卡片
 * 3. 工具 execute() 通过 Promise 阻塞等待用户响应
 * 4. 用户填写表单并点击提交，form_value 一次性回传
 * 5. Promise resolve，工具返回用户答案给 AI
 *
 * 所有卡片统一使用 form 容器，交互组件在本地缓存值，
 * 提交时通过 form_value 一次性回调，避免独立回调导致的 loading 闪烁。
 */

import { randomUUID } from 'node:crypto';
import type { OpenClawPluginApi, ClawdbotConfig } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import { getTicket } from '../core/lark-ticket';
import { larkLogger } from '../core/lark-logger';
import { createCardEntity, sendCardByCardId, updateCardKitCard } from '../card/cardkit';
import { checkToolRegistration, formatToolResult, formatToolError } from './helpers';
import { yieldCurrentTask } from '../channel/chat-queue';

const log = larkLogger('tools/ask-user-question');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 默认超时时间：3 分钟 */
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

const ACTION_SUBMIT = 'ask_user_submit';

/** Field name used for text input inside forms. */
const INPUT_FIELD_NAME = 'answer';

/** Field name used for select components inside forms. */
const SELECT_FIELD_NAME = 'selection';

/** Prefix for submit button name — questionId is appended for identification. */
const SUBMIT_BUTTON_PREFIX = 'ask_user_submit_';

/** Shared V2 card config */
const V2_CONFIG = { wide_screen_mode: true, update_multi: true, locales: ['zh_cn', 'en_us'] };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QuestionItem {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

interface PendingQuestion {
  questionId: string;
  chatId: string;
  accountId: string;
  senderOpenId: string;
  cardId: string;
  cfg: ClawdbotConfig;
  questions: QuestionItem[];
  resolve: (answers: Record<string, string>) => void;
  reject: (error: Error) => void;
  timeoutTimer: ReturnType<typeof setTimeout>;
  threadId?: string;
  resolved: boolean;
  cardSequence: number;
}

// ---------------------------------------------------------------------------
// Flow Manager
// ---------------------------------------------------------------------------

const byQuestionId = new Map<string, PendingQuestion>();
const byChatKey = new Map<string, PendingQuestion>();

function buildChatKey(accountId: string, chatId: string, threadId?: string): string {
  return threadId ? `${accountId}:${chatId}:thread:${threadId}` : `${accountId}:${chatId}`;
}

function registerPendingQuestion(pq: PendingQuestion): void {
  const chatKey = buildChatKey(pq.accountId, pq.chatId, pq.threadId);
  const existing = byChatKey.get(chatKey);
  if (existing && !existing.resolved) {
    rejectPendingQuestion(existing, new Error('Superseded by a new question'));
  }
  byQuestionId.set(pq.questionId, pq);
  byChatKey.set(chatKey, pq);
}

function cleanupPendingQuestion(pq: PendingQuestion): void {
  clearTimeout(pq.timeoutTimer);
  byQuestionId.delete(pq.questionId);
  const chatKey = buildChatKey(pq.accountId, pq.chatId, pq.threadId);
  if (byChatKey.get(chatKey) === pq) {
    byChatKey.delete(chatKey);
  }
}

function resolvePendingQuestion(pq: PendingQuestion, answers: Record<string, string>): void {
  if (pq.resolved) return;
  pq.resolved = true;
  cleanupPendingQuestion(pq);
  pq.resolve(answers);
}

function rejectPendingQuestion(pq: PendingQuestion, error: Error): void {
  if (pq.resolved) return;
  pq.resolved = true;
  cleanupPendingQuestion(pq);
  pq.reject(error);
}

// ---------------------------------------------------------------------------
// Field name helpers
// ---------------------------------------------------------------------------

function getInputFieldName(questionIndex: number): string {
  return `${INPUT_FIELD_NAME}_${questionIndex}`;
}

function getSelectFieldName(questionIndex: number): string {
  return `${SELECT_FIELD_NAME}_${questionIndex}`;
}

// ---------------------------------------------------------------------------
// Card Action Handler (used by event-handlers.ts)
// ---------------------------------------------------------------------------

/**
 * 处理 form 表单提交事件。
 *
 * 统一使用 form 后，所有值通过 form_value 一次性提交。
 * 不再需要处理 select/button 的独立回调。
 *
 * @returns 卡片回调响应，或 undefined 表示非本模块的 action
 */
export function handleAskUserAction(
  data: unknown,
  _cfg: ClawdbotConfig,
  accountId: string,
): unknown | undefined {
  let action: string | undefined;
  let operationId: string | undefined;
  let senderOpenId: string | undefined;
  let formValue: Record<string, unknown> | undefined;
  let openChatId: string | undefined;

  try {
    const event = data as {
      operator?: { open_id?: string };
      open_chat_id?: string;
      context?: { open_chat_id?: string; open_message_id?: string };
      action?: {
        tag?: string;
        name?: string;
        form_value?: Record<string, unknown>;
        value?: Record<string, unknown>;
      };
    };
    senderOpenId = event.operator?.open_id;
    // open_chat_id may be at top level or inside context (form submit callbacks use context)
    openChatId = event.open_chat_id ?? event.context?.open_chat_id;
    const actionTag = event.action?.tag;
    const actionName = event.action?.name;
    formValue = event.action?.form_value as Record<string, unknown> | undefined;

    log.info(
      `card action received: tag=${actionTag}, name=${actionName}, chat=${openChatId}, ` +
        `sender=${senderOpenId}, hasFormValue=${!!formValue}, hasValue=${!!event.action?.value}`,
    );

    // Extract action/operationId from button value (may not propagate for form submit)
    const val = event.action?.value;
    if (val && typeof val === 'object') {
      action = val.action as string | undefined;
      operationId = val.operation_id as string | undefined;
    }

    // Detect form submit by button name
    if (!action && actionName?.startsWith(SUBMIT_BUTTON_PREFIX)) {
      action = ACTION_SUBMIT;
      // Extract questionId from button name: ask_user_submit_<questionId>
      if (!operationId) {
        operationId = actionName.slice(SUBMIT_BUTTON_PREFIX.length);
      }
    }
    // Detect form submit by tag + formValue
    if (!action && actionTag === 'button' && formValue) {
      action = ACTION_SUBMIT;
    }
    // Some SDK versions emit tag='form_submit'
    if (!action && actionTag === 'form_submit') {
      action = ACTION_SUBMIT;
      if (!formValue && event.action) {
        formValue = event.action as unknown as Record<string, unknown>;
      }
    }
  } catch {
    return undefined;
  }

  if (action !== ACTION_SUBMIT) return undefined;

  // Resolve pending question — try operationId first, then context-based lookup
  if (!operationId || !byQuestionId.has(operationId)) {
    operationId = findPendingQuestionByContext(accountId, openChatId, senderOpenId)?.questionId;
  }
  if (!operationId) return undefined;

  const pq = byQuestionId.get(operationId);
  if (!pq) {
    log.warn(`ask-user action: question ${operationId} not found (expired or already handled)`);
    return { toast: { type: 'info', content: '该问题已过期或已被回答' } };
  }

  if (senderOpenId && pq.senderOpenId && senderOpenId !== pq.senderOpenId) {
    return { toast: { type: 'warning', content: '只有被提问的用户可以回答此问题' } };
  }

  if (!formValue) {
    log.warn(`ask-user submit without form_value for question ${operationId}`);
    return { toast: { type: 'error', content: '表单数据丢失，请重试' } };
  }

  log.info(`form_value: ${JSON.stringify(formValue)}`);

  // ---- Parse form_value → answers ----
  const answers: Record<string, string> = {};
  const unanswered: string[] = [];

  for (let i = 0; i < pq.questions.length; i++) {
    const q = pq.questions[i];
    let answer: string | undefined;

    if (q.options.length === 0) {
      // Free-text input
      answer = readFormTextField(formValue, getInputFieldName(i));
    } else if (q.multiSelect) {
      // Multi-select
      const selected = readFormMultiSelect(formValue, getSelectFieldName(i));
      if (selected.length > 0) {
        answer = selected.join(', ');
      }
    } else {
      // Single-select
      answer = readFormTextField(formValue, getSelectFieldName(i));
    }

    if (answer) {
      answers[q.question] = answer;
    } else {
      unanswered.push(q.header);
    }
  }

  if (unanswered.length > 0) {
    return {
      toast: { type: 'warning', content: `请先完成: ${unanswered.join(', ')}` },
    };
  }

  resolvePendingQuestion(pq, answers);

  setImmediate(async () => {
    try {
      await updateCardToAnswered(pq, answers);
    } catch (err) {
      log.warn(`failed to update card to answered state: ${err}`);
    }
  });

  log.info(`question ${operationId} submitted`);
  return {};
}

/**
 * 通过 chat 上下文查找 pending question（降级方案）。
 */
function findPendingQuestionByContext(
  accountId: string,
  openChatId?: string,
  senderOpenId?: string,
): PendingQuestion | undefined {
  // Try exact chat key lookup first (fastest path)
  if (openChatId) {
    const chatKey = buildChatKey(accountId, openChatId);
    const pq = byChatKey.get(chatKey);
    if (pq && !pq.resolved) {
      if (!senderOpenId || !pq.senderOpenId || senderOpenId === pq.senderOpenId) {
        return pq;
      }
    }
  }

  // Fallback: scan all pending questions by accountId (+ optional chatId/sender filtering)
  for (const candidate of byQuestionId.values()) {
    if (candidate.resolved) continue;
    if (candidate.accountId !== accountId) continue;
    if (openChatId && candidate.chatId !== openChatId) continue;
    if (senderOpenId && candidate.senderOpenId && senderOpenId !== candidate.senderOpenId) continue;
    return candidate;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Form value readers
// ---------------------------------------------------------------------------

function readFormTextField(formValue: Record<string, unknown>, fieldName: string): string | undefined {
  const value = formValue[fieldName];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readFormMultiSelect(formValue: Record<string, unknown>, fieldName: string): string[] {
  const raw = formValue[fieldName];
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw.trim());
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
      }
    } catch {
      // not JSON
    }
    return [raw.trim()];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Card Builders — unified form layout
// ---------------------------------------------------------------------------

/**
 * Build a left-right row: label on left, control on right.
 */
function buildLabeledRow(
  label: Record<string, unknown>,
  control: Record<string, unknown>,
): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'stretch',
    horizontal_spacing: '8px',
    margin: '12px 0 0 0',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [label],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 3,
        vertical_align: 'center',
        elements: [control],
      },
    ],
  };
}

/**
 * Build form elements for a single question.
 *
 * All controls use `name` for form_value collection. No `value` property
 * is set on interactive components — they do not fire individual callbacks.
 */
function buildQuestionFormElements(
  q: QuestionItem,
  questionIndex: number,
): Record<string, unknown>[] {
  const elems: Record<string, unknown>[] = [];
  const labelMd = { tag: 'markdown', content: `**${q.header}**` };

  // Question description as subtitle
  if (q.question && q.question !== q.header) {
    elems.push({ tag: 'markdown', content: q.question, text_size: 'notation' });
  }

  if (q.options.length === 0) {
    // ---- Free-text input ----
    elems.push(
      buildLabeledRow(labelMd, {
        tag: 'input',
        name: getInputFieldName(questionIndex),
        placeholder: {
          tag: 'plain_text',
          content: '请输入...',
          i18n_content: { zh_cn: '请输入...', en_us: 'Type your answer...' },
        },
      }),
    );
    return elems;
  }

  // ---- Build option list ----
  const selectOptions = q.options.map((opt) => ({
    text: { tag: 'plain_text', content: opt.label },
    value: opt.label,
  }));

  if (q.multiSelect) {
    // ---- Multi-select dropdown ----
    elems.push(
      buildLabeledRow(labelMd, {
        tag: 'multi_select_static',
        name: getSelectFieldName(questionIndex),
        placeholder: {
          tag: 'plain_text',
          content: '请选择...',
          i18n_content: { zh_cn: '请选择...', en_us: 'Select options...' },
        },
        options: selectOptions,
      }),
    );
  } else {
    // ---- Single-select dropdown ----
    elems.push(
      buildLabeledRow(labelMd, {
        tag: 'select_static',
        name: getSelectFieldName(questionIndex),
        placeholder: {
          tag: 'plain_text',
          content: '请选择...',
          i18n_content: { zh_cn: '请选择...', en_us: 'Select an option...' },
        },
        options: selectOptions,
      }),
    );
  }

  // ---- Option descriptions ----
  const descLines = q.options.filter((opt) => opt.description).map((opt) => `• **${opt.label}**: ${opt.description}`);
  if (descLines.length > 0) {
    elems.push({ tag: 'markdown', content: descLines.join('\n'), text_size: 'notation' });
  }

  return elems;
}

/**
 * Build the full interactive ask-user card.
 *
 * All elements are wrapped in a single `form` container.
 * Submit button uses `form_action_type: "submit"` to collect all values.
 */
function buildAskUserCard(questions: QuestionItem[], questionId: string): Record<string, unknown> {
  const formElements: Record<string, unknown>[] = [];

  for (let i = 0; i < questions.length; i++) {
    if (i > 0) {
      formElements.push({ tag: 'hr' });
    }
    formElements.push(...buildQuestionFormElements(questions[i], i));
  }

  // Submit button
  formElements.push({ tag: 'hr' });
  formElements.push({
    tag: 'button',
    // Encode questionId in button name — value does NOT propagate for form submit buttons
    name: `${SUBMIT_BUTTON_PREFIX}${questionId}`,
    text: {
      tag: 'plain_text',
      content: '📮 提交',
      i18n_content: { zh_cn: '📮 提交', en_us: '📮 Submit' },
    },
    type: 'primary',
    form_action_type: 'submit',
  });

  return {
    schema: '2.0',
    config: V2_CONFIG,
    header: {
      title: {
        tag: 'plain_text',
        content: '需要你的确认',
        i18n_content: { zh_cn: '需要你的确认', en_us: 'Your Input Needed' },
      },
      subtitle: {
        tag: 'plain_text',
        content: `共 ${questions.length} 个问题`,
        i18n_content: {
          zh_cn: `共 ${questions.length} 个问题`,
          en_us: `${questions.length} question${questions.length > 1 ? 's' : ''}`,
        },
      },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: '待回答' },
          color: 'blue',
        },
      ],
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'form',
          name: 'ask_user_form',
          elements: formElements,
        },
      ],
    },
  };
}

function buildAnsweredCard(questions: QuestionItem[], answers: Record<string, string>): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const answer = answers[q.question] ?? '(no answer)';
    if (i > 0) {
      elements.push({ tag: 'hr' });
    }
    elements.push(
      buildLabeledRow(
        { tag: 'markdown', content: `**${q.header}**` },
        { tag: 'markdown', content: `✅ **${answer}**` },
      ),
    );
  }

  return {
    schema: '2.0',
    config: V2_CONFIG,
    header: {
      title: {
        tag: 'plain_text',
        content: '已收到回答',
        i18n_content: { zh_cn: '已收到回答', en_us: 'Response Received' },
      },
      subtitle: {
        tag: 'plain_text',
        content: `共 ${questions.length} 个问题`,
        i18n_content: {
          zh_cn: `共 ${questions.length} 个问题`,
          en_us: `${questions.length} question${questions.length > 1 ? 's' : ''}`,
        },
      },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: '已完成' },
          color: 'green',
        },
      ],
      template: 'green',
    },
    body: { elements },
  };
}

function buildExpiredCard(questions: QuestionItem[]): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (i > 0) {
      elements.push({ tag: 'hr' });
    }
    elements.push(
      buildLabeledRow(
        { tag: 'markdown', content: `**${q.header}**` },
        { tag: 'markdown', content: q.question },
      ),
    );
  }

  elements.push({
    tag: 'markdown',
    content: '⏱ 该问题已过期',
    i18n_content: { zh_cn: '⏱ 该问题已过期', en_us: '⏱ This question has expired' },
    text_size: 'notation',
  });

  return {
    schema: '2.0',
    config: V2_CONFIG,
    header: {
      title: {
        tag: 'plain_text',
        content: '问题已过期',
        i18n_content: { zh_cn: '问题已过期', en_us: 'Question Expired' },
      },
      subtitle: {
        tag: 'plain_text',
        content: '未在规定时间内回答',
        i18n_content: { zh_cn: '未在规定时间内回答', en_us: 'No response within time limit' },
      },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: '已过期' },
          color: 'neutral',
        },
      ],
      template: 'grey',
    },
    body: { elements },
  };
}

// ---------------------------------------------------------------------------
// Card Update Helpers
// ---------------------------------------------------------------------------

async function updateCardToAnswered(pq: PendingQuestion, answers: Record<string, string>): Promise<void> {
  const card = buildAnsweredCard(pq.questions, answers);
  pq.cardSequence++;
  await updateCardKitCard({
    cfg: pq.cfg,
    cardId: pq.cardId,
    card,
    sequence: pq.cardSequence,
    accountId: pq.accountId,
  });
}

async function updateCardToExpired(pq: PendingQuestion): Promise<void> {
  const card = buildExpiredCard(pq.questions);
  pq.cardSequence++;
  await updateCardKitCard({
    cfg: pq.cfg,
    cardId: pq.cardId,
    card,
    sequence: pq.cardSequence,
    accountId: pq.accountId,
  });
}

// ---------------------------------------------------------------------------
// Tool Schema
// ---------------------------------------------------------------------------

const AskUserQuestionSchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: 'The question to ask the user' }),
      header: Type.String({ description: 'Short label for the question (max 12 chars)' }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: 'Display text for this option' }),
          description: Type.String({ description: 'Explanation of what this option means' }),
        }),
        {
          description:
            'Available choices. Renders as a dropdown. ' +
            'Leave empty ([]) for free-text input — the user will see a text field instead.',
          maxItems: 10,
        },
      ),
      multiSelect: Type.Boolean({
        description: 'Whether multiple options can be selected (ignored when options is empty)',
      }),
    }),
    {
      description: 'Questions to ask the user (1-6 questions)',
      minItems: 1,
      maxItems: 6,
    },
  ),
});

// ---------------------------------------------------------------------------
// Tool Registration
// ---------------------------------------------------------------------------

export function registerAskUserQuestionTool(api: OpenClawPluginApi): void {
  const toolName = 'feishu_ask_user_question';

  if (!checkToolRegistration(api, toolName)) return;

  const cfg = api.config;

  api.registerTool({
    name: toolName,
    label: 'Ask User Question',
    description:
      'Ask the user a question and wait for their response. ' +
      'Sends an interactive Feishu card with the question. ' +
      'For selection questions, provide options (renders as dropdown). ' +
      'For free-text input, set options to an empty array. ' +
      'The user must answer inside the Feishu card. ' +
      'Use this when you need clarification or a decision from the user.',
    parameters: AskUserQuestionSchema,

    async execute(_toolCallId: string, params: unknown) {
      const { questions } = params as { questions: QuestionItem[] };

      const ticket = getTicket();
      if (!ticket) {
        return formatToolError('AskUserQuestion can only be used in a Feishu message context');
      }

      const { chatId, accountId, senderOpenId, threadId } = ticket;
      if (!senderOpenId) {
        return formatToolError('Cannot determine the target user (no senderOpenId in ticket)');
      }

      const questionId = randomUUID();
      log.info(`creating ask-user-question: id=${questionId}, questions=${questions.length}, chat=${chatId}`);

      // 1. Build and send card
      const card = buildAskUserCard(questions, questionId);

      let cardId: string | null;
      try {
        cardId = await createCardEntity({ cfg, card, accountId });
      } catch (err) {
        log.error(`failed to create card entity: ${err}`);
        return formatToolError(`Failed to create question card: ${err}`);
      }

      if (!cardId) {
        return formatToolError('Failed to create question card: no card_id returned');
      }

      try {
        await sendCardByCardId({
          cfg,
          to: chatId,
          cardId,
          replyToMessageId: ticket.messageId,
          replyInThread: Boolean(threadId),
          accountId,
        });
      } catch (err) {
        log.error(`failed to send card: ${err}`);
        return formatToolError(`Failed to send question card: ${err}`);
      }

      // 2. Register pending question
      const answersPromise = new Promise<Record<string, string>>((resolve, reject) => {
        const timeoutTimer = setTimeout(() => {
          const pq = byQuestionId.get(questionId);
          if (pq && !pq.resolved) {
            rejectPendingQuestion(pq, new Error('Question timed out: no response received within 5 minutes'));
            setImmediate(async () => {
              try {
                await updateCardToExpired(pq);
              } catch (err) {
                log.warn(`failed to update card to expired state: ${err}`);
              }
            });
          }
        }, DEFAULT_TIMEOUT_MS);

        registerPendingQuestion({
          questionId,
          chatId,
          accountId,
          senderOpenId,
          cardId: cardId!,
          cfg,
          questions,
          resolve,
          reject,
          timeoutTimer,
          threadId,
          resolved: false,
          cardSequence: 1,
        });
      });

      // 3. Yield queue so group chat isn't blocked
      yieldCurrentTask(accountId, chatId, threadId);
      log.info(`yielded chat queue for question ${questionId}`);

      // 4. Wait for answer
      try {
        const answers = await answersPromise;
        log.info(`question ${questionId} answered: ${JSON.stringify(answers)}`);
        return formatToolResult({ answers });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(`question ${questionId} failed: ${errMsg}`);
        return formatToolError(errMsg);
      }
    },
  });

  log.info(`registered tool: ${toolName}`);
}
