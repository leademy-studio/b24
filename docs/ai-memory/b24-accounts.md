---
name: b24-accounts
description: "Bitrix24 account roles — user1 system master, user131 owner's admin; REST webhook is bound to user1"
metadata: 
  node_type: memory
  type: project
  originSessionId: 93056715-a7e0-4ac1-b09f-8a5ef3d1248f
---

Bitrix24 portal leademy.bitrix24.ru account model:
- **user 1** ("leademy digital") = системный мастер-аккаунт; the inbound REST webhook in `.env` (`B24_WEBHOOK_BASE`) authenticates as this user (ADMIN=true).
- **user 131** (Равиль Шакиров, r.shakirov@leademy.digital) = owner's personal account, granted portal administrator status on 2026-06-22.

Bitrix task visibility: an **administrator automatically sees/accesses ALL tasks** (confirmed by docs for `tasks.task.list`/`tasks.task.get` and verified via `tasks.task.getaccess` — admin gets EDIT/REMOVE=true on tasks they don't participate in). No REST method grants a *non-admin* a "see all tasks" role — that is UI-only (Задачи → права доступа, расширенный режим).

On 2026-06-22 user 131 was added to all 54 workgroups/projects via `sonet_group.user.add` (loop over `sonet_group.get` ids). Related: [[owner-dashboard-project]], [[b24-routine-task-model]].
