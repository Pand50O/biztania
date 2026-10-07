create table if not exists public.concierge_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists concierge_conversations_user_updated_idx
  on public.concierge_conversations (user_id, updated_at desc);

alter table public.concierge_conversations enable row level security;

create policy "Users can read their own conversations"
  on public.concierge_conversations for select
  using (auth.uid() = user_id);

create policy "Users can create their own conversations"
  on public.concierge_conversations for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own conversations"
  on public.concierge_conversations for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own conversations"
  on public.concierge_conversations for delete
  using (auth.uid() = user_id);
