import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  dispatchToAgentMock,
  getLarkAccountMock,
} = vi.hoisted(() => ({
  dispatchToAgentMock: vi.fn(),
  getLarkAccountMock: vi.fn(),
}))

vi.mock('../src/messaging/inbound/dispatch', () => ({
  dispatchToAgent: dispatchToAgentMock,
}))

vi.mock('../src/core/accounts', () => ({
  getLarkAccount: getLarkAccountMock,
}))

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import { handleFeishuVcMeetingInvited } from '../src/messaging/inbound/vc-meeting-invited-handler'
import { SYNTHETIC_VC_CHAT_ID } from '../src/core/synthetic-target'

beforeEach(() => {
  vi.clearAllMocks()

  getLarkAccountMock.mockReturnValue({
    accountId: 'default',
    enabled: true,
    configured: true,
    brand: 'feishu',
    config: {},
    appId: 'cli_xxx',
    appSecret: 'secret',
  })
})

describe('handleFeishuVcMeetingInvited', () => {
  it('dispatches a synthetic natural-language inbound with synthetic chatId', async () => {
    await handleFeishuVcMeetingInvited({
      cfg: {} as never,
      event: {
        meeting: { id: '6911188411934433028', meeting_no: '123456789', topic: '周会' },
        inviter: { id: { open_id: 'ou_inviter_1' }, user_name: 'Alice' },
        invite_time: '1712345678',
      },
      accountId: 'default',
    })

    expect(dispatchToAgentMock).toHaveBeenCalledTimes(1)
    expect(dispatchToAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          // chatId is a sentinel, NOT the inviter open_id — this prevents
          // downstream IM paths from sending DMs to the inviter.
          chatId: SYNTHETIC_VC_CHAT_ID,
          senderId: 'ou_inviter_1',
          chatType: 'p2p',
          content: 'Join the meeting with meeting number 123456789.',
        }),
        extraInboundFields: expect.objectContaining({
          SyntheticEventType: 'vc.bot.meeting_invited_v1',
          VcMeetingId: '6911188411934433028',
          VcMeetingNo: '123456789',
          VcMeetingTopic: '周会',
          // Real inviter open_id is preserved here so agents can still
          // @-mention the inviter explicitly when appropriate.
          VcInviterOpenId: 'ou_inviter_1',
          VcInviteTime: '1712345678',
        }),
        replyToMessageId: undefined,
        skipTyping: true,
      }),
    )
  })

  it('skips dispatch when inviter ids are missing', async () => {
    await handleFeishuVcMeetingInvited({
      cfg: {} as never,
      event: {
        meeting: { meeting_no: '123456789', topic: '周会' },
        bot: { id: { user_id: 'u_bot_1' }, user_name: 'OpenClaw Bot' },
        invite_time: '1712345678',
      },
      accountId: 'default',
    })

    expect(dispatchToAgentMock).not.toHaveBeenCalled()
  })

  it('skips dispatch entirely when meeting_no is missing', async () => {
    await handleFeishuVcMeetingInvited({
      cfg: {} as never,
      event: {
        meeting: { topic: '周会' },
        inviter: { id: { open_id: 'ou_inviter_1' } },
        invite_time: '1712345678',
      },
      accountId: 'default',
    })

    expect(dispatchToAgentMock).not.toHaveBeenCalled()
  })

  it('skips dispatch when both inviter and bot are absent', async () => {
    await handleFeishuVcMeetingInvited({
      cfg: {} as never,
      event: {
        meeting: { meeting_no: '123456789' },
        invite_time: '1712345678',
      },
      botOpenId: 'ou_ctx_bot',
      accountId: 'default',
    })

    expect(dispatchToAgentMock).not.toHaveBeenCalled()
  })

  it('skips dispatch when inviter ids are empty strings', async () => {
    await handleFeishuVcMeetingInvited({
      cfg: {} as never,
      event: {
        meeting: { meeting_no: '123456789' },
        // Inviter present but every id is empty — this must be treated
        // as a malformed event and skipped.
        inviter: { id: { open_id: '', user_id: '', union_id: '' }, user_name: 'Bob' },
        bot: { id: { open_id: 'ou_bot_fallback' }, user_name: 'OpenClaw Bot' },
        invite_time: '1712345678',
      },
      accountId: 'default',
    })

    expect(dispatchToAgentMock).not.toHaveBeenCalled()
  })
})
