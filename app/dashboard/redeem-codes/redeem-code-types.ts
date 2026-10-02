export type ChannelOption = { id: number; name: string };
export type ModelOption = { alias: string; real_model: string };

export type CodeRow = {
  id: number;
  code: string;
  batch_id: string;
  token_quota: number | null;
  request_quota: number | null;
  allowed_channel_ids: string;
  allowed_model_aliases: string;
  expires_at: string | null;
  enabled: number;
  max_uses: number;
  used_count: number;
  note: string | null;
  created_by: number | null;
  created_by_username: string | null;
  redeemed_users: number;
  used_tokens_sum: number;
  used_requests_sum: number;
  created_at: string;
};
