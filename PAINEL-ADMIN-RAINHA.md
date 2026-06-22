# Painel Admin — Guia para replicar no app Rainha

Documento de referência para recriar, no projeto **Rainha**, o mesmo painel admin já
implementado no **Irmandade Club**. Os dois apps usam o mesmo padrão (Nuxt 4 SPA +
Nitro + MongoDB + webhook Lastlink), então o backend é praticamente copiável; só
mudam nomes de DB/env e detalhes de marca.

---

## 1. O que o painel faz

- **Login admin** próprio (e-mail + senha, cookie HMAC assinado, expiração no servidor, rate-limit).
- **Dashboard** (`/admin`) com:
  - 8 cards de métricas: Usuários, Ativos 48h, PIX gerados, Valor total, Conversão %, Novos 7d, Ticket médio, **Em risco** (clicável).
  - **Gráfico de atividade** dos últimos 14 dias (área SVG com linha suave + média).
  - **Tabela de usuários** com: Telefone (link WhatsApp), **Tag** (editável), **Contato/status** (editável), Assinatura, PIX (qtd+valor), Marca, 1º acesso, Último acesso, Status (ativo/bloqueado), bloquear/desbloquear.
  - **Filtros**: busca + chips de risco (24h / 48h+ / Pago s/ acesso / todos), Pago/Free, Ativos/Bloqueados, Marca.
  - **Assinantes-only**: quem pagou (subscriptions) mas nunca abriu o app aparece como usuário ("nunca acessou").
  - **Exportar CSV** (respeita os filtros, BOM pro Excel, anti-injection).
  - **Registrar FTD** (primeiro depósito) — grava como PIX na coleção `deposits`.
  - Tabela de **Depósitos**.
- **Página webhook** (`/admin/webhook`) pra liberar assinatura manualmente quando o webhook falha.

### Tags de risco (regra de negócio central)

A tag de risco é **calculada** a partir dos dados, com **override manual** por cima:

- `risk_24h`: assinante pago, 1º acesso **depois** de assinar, **zero PIX**, entre 24h e 48h do 1º acesso.
- `risk_48h`: igual, mas passou de 48h.
- `risk_no_access`: pago, **nunca abriu o app**, zero PIX, já passou 24h de carência da assinatura.
- Override manual (`auto` / `none` / uma das 3): **a manual manda** — afeta a tag exibida, o filtro, o card "Em risco" e o CSV.

---

## 2. Pré-requisitos / o que confirmar no Rainha

- **Stack:** Nuxt 4 (`ssr: false`), Nitro, `mongodb` driver nativo, `@nuxt/icon`.
- **Collections** (confirmar se os nomes batem com o Rainha):
  - `app_users` — quem abriu o app (heartbeat). Campos usados: `email`, `name`, `phone`, `brand_slug`, `blocked`, `blocked_at`, `first_seen_at`, `last_seen_at`, `cactus_user_id`.
  - `subscriptions` — pagamentos (webhook Lastlink). Campos: `email`, `status` (`active`/`inactive`), `role`, `created_at`, e (após este guia) `phone`, `name`.
  - `deposits` — PIX gerados. Campos: `email`, `brand_slug`, `amount`, `transaction_id`, `status`, `created_at`.
  - `user_contact_status` — **nova**, criada pelo painel: `{ email, status, tag, updated_at, ... }`.
- **Env vars** (com defaults no código, mas configure em produção):
  - `MONGODB_URI`, e o nome do banco no `mongodb.ts` (no Irmandade é `irmandade-hyper` → trocar pelo do Rainha).
  - `ADMIN_ALLOWED_EMAILS` (lista separada por vírgula), `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`.

---

## 3. Backend — utils

### `server/utils/mongodb.ts`
Igual ao do Rainha (já deve existir). Só garanta um `getDb()` que devolve o `Db`.

### `server/utils/adminAuth.ts` (copiar inteiro)

```ts
import { createHmac, timingSafeEqual } from 'crypto'

const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || 'TROQUE-ESTE-SECRET'
export const COOKIE_NAME = 'rainha_admin_session' // troque o prefixo p/ Rainha
export const MAX_AGE = 8 * 60 * 60 // 8h

const isProduction = process.env.NODE_ENV === 'production'
const usingDefaultSecret = !process.env.ADMIN_SESSION_SECRET?.trim()
const usingDefaultPassword = !process.env.ADMIN_PASSWORD?.trim()
if (isProduction && (usingDefaultSecret || usingDefaultPassword)) {
  console.warn('[adminAuth] ATENÇÃO: usando secret/senha padrão inseguros em produção.')
}

export interface SessionPayload { email: string; iat: number }

export const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a); const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export const signSession = (payload: SessionPayload): string => {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64')
  const sig = createHmac('sha256', SESSION_SECRET).update(data).digest('hex')
  return `${data}.${sig}`
}

export const verifySession = (token: string): SessionPayload | null => {
  const i = token.lastIndexOf('.')
  if (i === -1) return null
  const data = token.slice(0, i); const sig = token.slice(i + 1)
  const expected = createHmac('sha256', SESSION_SECRET).update(data).digest('hex')
  if (!safeEqual(sig, expected)) return null
  try {
    const p = JSON.parse(Buffer.from(data, 'base64').toString()) as SessionPayload
    if (!p || typeof p.iat !== 'number' || !p.email) return null
    if (Date.now() - p.iat > MAX_AGE * 1000) return null         // expira no servidor
    if (!getAllowedEmails().includes(p.email)) return null        // revoga se saiu da allowlist
    return p
  } catch { return null }
}

export const getAllowedEmails = (): string[] => {
  const env = process.env.ADMIN_ALLOWED_EMAILS || process.env.ADMIN_EMAIL
  if (env?.trim()) return env.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  return ['email-admin-rainha@exemplo.com'] // fallback — troque
}

export const getAdminPassword = (): string => process.env.ADMIN_PASSWORD || 'admin123'

export const getAdminSession = (event: any): SessionPayload | null => {
  const cookie = getCookie(event, COOKIE_NAME)
  if (!cookie) return null
  return verifySession(cookie)
}

// guarda única usada por TODAS as rotas /api/admin/* (exceto login/logout)
export const requireAdminSession = (event: any): SessionPayload => {
  const session = getAdminSession(event)
  if (!session) throw createError({ statusCode: 401, message: 'Sessão admin inválida ou expirada' })
  return session
}
```

### `server/utils/adminUserEnrichment.ts` (copiar inteiro — é o coração)

Faz `$lookup` de subscriptions + deposits + user_contact_status, calcula assinatura,
contagem/soma de PIX, status de contato, tag automática e **tag efetiva** (override manda).
E injeta os assinantes-only (pagaram, sem registro em `app_users`).

```ts
import type { Document } from 'mongodb'

export const HOUR_MS = 60 * 60 * 1000

// Injeta assinantes ativos SEM registro em app_users como "usuários" sintéticos.
export const buildSubsOnlyUnion = (rx: RegExp | null = null): Document[] => [
  {
    $unionWith: {
      coll: 'subscriptions',
      pipeline: [
        { $match: { status: 'active' } },
        { $group: { _id: '$email', phone: { $first: '$phone' }, name: { $first: '$name' } } },
        { $match: { _id: { $ne: null } } },
        { $lookup: { from: 'app_users', localField: '_id', foreignField: 'email', as: '_au' } },
        { $match: { _au: { $size: 0 } } },
        {
          $project: {
            _id: 0, email: '$_id',
            name: { $ifNull: ['$name', null] },
            phone: { $ifNull: ['$phone', null] },
            brand_slug: { $literal: null },
            blocked: { $literal: false },
            first_seen_at: { $literal: null },
            last_seen_at: { $literal: null },
            source: { $literal: 'subscription' }
          }
        },
        ...(rx ? [{ $match: { email: rx } }] : [])
      ]
    }
  }
]

export const buildUserEnrichmentStages = (now = new Date()): Document[] => {
  const cutoff24 = new Date(now.getTime() - 24 * HOUR_MS)
  const cutoff48 = new Date(now.getTime() - 48 * HOUR_MS)
  return [
    { $lookup: { from: 'subscriptions', localField: 'email', foreignField: 'email', as: 'sub' } },
    { $lookup: { from: 'deposits', localField: 'email', foreignField: 'email', as: 'deps' } },
    { $lookup: { from: 'user_contact_status', localField: 'email', foreignField: 'email', as: 'cstatus' } },
    {
      $addFields: {
        subscription: { $cond: [{ $eq: [{ $arrayElemAt: ['$sub.status', 0] }, 'active'] }, 'paid', 'free'] },
        sub_created_at: { $arrayElemAt: ['$sub.created_at', 0] },
        deposits_count: { $size: '$deps' },
        deposits_sum: { $sum: '$deps.amount' },
        contact_status: { $ifNull: [{ $arrayElemAt: ['$cstatus.status', 0] }, 'pendente'] },
        tag_override: { $ifNull: [{ $arrayElemAt: ['$cstatus.tag', 0] }, 'auto'] }
      }
    },
    {
      $addFields: {
        risk_eligible: {
          $and: [
            { $eq: ['$subscription', 'paid'] },
            { $gt: ['$first_seen_at', null] },
            { $gt: ['$sub_created_at', null] },
            { $gte: ['$first_seen_at', '$sub_created_at'] },
            { $eq: ['$deposits_count', 0] }
          ]
        },
        no_access_eligible: {
          $and: [
            { $eq: ['$subscription', 'paid'] },
            { $gt: ['$sub_created_at', null] },
            { $not: [{ $gt: ['$first_seen_at', null] }] },
            { $eq: ['$deposits_count', 0] }
          ]
        }
      }
    },
    {
      $addFields: {
        auto_risk_tag: {
          $switch: {
            branches: [
              { case: { $and: ['$risk_eligible', { $lte: ['$first_seen_at', cutoff48] }] }, then: 'risk_48h' },
              { case: { $and: ['$risk_eligible', { $lte: ['$first_seen_at', cutoff24] }] }, then: 'risk_24h' },
              { case: { $and: ['$no_access_eligible', { $lte: ['$sub_created_at', cutoff24] }] }, then: 'risk_no_access' }
            ],
            default: null
          }
        }
      }
    },
    {
      $addFields: {
        // override manda: 'auto' usa o cálculo, 'none' zera, outro = a própria tag
        risk_tag: {
          $switch: {
            branches: [
              { case: { $eq: ['$tag_override', 'none'] }, then: null },
              { case: { $eq: ['$tag_override', 'auto'] }, then: '$auto_risk_tag' }
            ],
            default: '$tag_override'
          }
        }
      }
    },
    { $project: { sub: 0, deps: 0, cstatus: 0, risk_eligible: 0, no_access_eligible: 0 } }
  ]
}
```

> **Pegadinhas de Mongo aprendidas aqui:**
> - Em `$project`, valores nus (`null`/`false`/string) viram exclusão/path — use `$literal`/`$ifNull`.
> - `$gt` contra `null` usa a ordem de tipos do BSON: serve como "campo existe e não é null".
> - `$unionWith` injeta os assinantes-only **antes** do enriquecimento, pra eles também ganharem tag/risco.

---

## 4. Backend — endpoints (`server/api/admin/`)

Todos (menos login/logout) começam com `requireAdminSession(event)`.

| Arquivo | Método/rota | O que faz |
|---|---|---|
| `login.post.ts` | POST `/api/admin/login` | valida e-mail (allowlist) + senha (timing-safe) + **rate-limit por IP** (8 tentativas/15min → 429), seta cookie HMAC. |
| `logout.post.ts` | POST `/api/admin/logout` | apaga o cookie. |
| `me.get.ts` | GET `/api/admin/me` | devolve `{ adminEmail }` se sessão válida (usado pelo middleware). |
| `stats.get.ts` | GET `/api/admin/stats` | métricas dos cards (ver abaixo). |
| `users.get.ts` | GET `/api/admin/users` | lista paginada com enriquecimento + união + filtros + `brands`. |
| `users/block.post.ts` | POST | bloqueia/desbloqueia (upsert em app_users — cobre assinante-only). |
| `users/status.post.ts` | POST | salva status de contato (`pendente`/`contatado`/`respondeu`/`convertido`/`ignorado`). |
| `users/tag.post.ts` | POST | salva override de tag (`auto`/`none`/`risk_24h`/`risk_48h`/`risk_no_access`). |
| `users/export.get.ts` | GET | CSV com os filtros aplicados. |
| `deposits.get.ts` | GET | lista de PIX paginada. |
| `activity.get.ts` | GET | série de 14 dias (novos usuários + PIX/dia). |
| `ftd.post.ts` | POST | registra FTD como depósito (`is_ftd: true`, `source: 'admin-ftd'`). |
| `subscriptions/approve.post.ts` | POST | libera acesso pago manual (cola e-mails → upsert active em subscriptions). |

### `users.get.ts` (estrutura — copiar e ajustar)

```ts
import { getDb } from '../../utils/mongodb'
import { requireAdminSession } from '../../utils/adminAuth'
import { buildUserEnrichmentStages, buildSubsOnlyUnion } from '../../utils/adminUserEnrichment'

export default defineEventHandler(async (event) => {
  requireAdminSession(event)
  const q = getQuery(event)
  const search = String(q.search || '').trim()
  const skip = Math.max(0, parseInt(String(q.skip)) || 0)
  const limit = Math.min(100, Math.max(1, parseInt(String(q.limit)) || 50))
  const risk = String(q.risk || ''); const subscription = String(q.subscription || '')
  const status = String(q.status || ''); const brand = String(q.brand || '').trim()
  const rx = search ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null

  const match: Record<string, any> = {}
  if (rx) match.$or = [{ email: rx }, { name: rx }, { phone: rx }]
  if (status === 'active') match.blocked = { $ne: true }
  if (status === 'blocked') match.blocked = true
  if (brand) match.brand_slug = brand

  const includeSubsOnly = status !== 'blocked' && !brand
  const subUnion = includeSubsOnly ? buildSubsOnlyUnion(rx) : []

  const post: Record<string, any> = {}
  if (subscription === 'paid' || subscription === 'free') post.subscription = subscription
  if (risk === '24h') post.risk_tag = 'risk_24h'
  if (risk === '48h') post.risk_tag = 'risk_48h'
  if (risk === 'no_access') post.risk_tag = 'risk_no_access'
  if (risk === 'any') post.risk_tag = { $ne: null }

  const pipeline: any[] = [
    { $match: match },
    ...subUnion,
    ...buildUserEnrichmentStages(),
    ...(Object.keys(post).length ? [{ $match: post }] : []),
    { $sort: { last_seen_at: -1 } },
    { $facet: { rows: [{ $skip: skip }, { $limit: limit }], meta: [{ $count: 'total' }] } }
  ]
  const db = await getDb()
  const col = db.collection('app_users')
  const [agg, brands] = await Promise.all([
    col.aggregate(pipeline).toArray(),
    col.distinct('brand_slug', { brand_slug: { $nin: [null, ''] } })
  ])
  const r = agg[0]
  return { users: r?.rows || [], total: r?.meta?.[0]?.total || 0, brands: (brands as string[]).sort() }
})
```

### `stats.get.ts` (pontos-chave)

`totalUsers` = `app_users` + assinantes-only; `atRisk` usa `buildSubsOnlyUnion()` + enriquecimento e conta `risk_tag != null` (pra bater com a tabela). Demais: `active48h` (last_seen ≥ 48h), `newToday`/`new7d` (first_seen), `depositsCount`/`depositsSum`, `avgTicket`, `conversionRate` (% de assinantes ativos com ≥1 PIX).

### `users/status.post.ts` e `users/tag.post.ts` (mesmo molde)

```ts
// status.post.ts — valida status em ['pendente','contatado','respondeu','convertido','ignorado']
// tag.post.ts    — valida tag em ['auto','none','risk_24h','risk_48h','risk_no_access']
// ambos: upsert em user_contact_status por email, set { status|tag, updated_at, updated_by: session.email }
```

### `ftd.post.ts`

```ts
// valida email + amount (>0, <=1_000_000); insere em deposits:
// { email, brand_slug, amount, transaction_id: null, status: 'generated',
//   is_ftd: true, source: 'admin-ftd', registered_by: session.email, created_at: new Date() }
```

### `users/export.get.ts`
Mesmos filtros do `users.get.ts`, sem paginação (`$limit` alto), monta CSV:
- delimitador `;`, **BOM UTF-8** (`'﻿' + ...`), datas em `America/Sao_Paulo`, valores `19,90`.
- **anti-injection**: campo que começa com `= + - @` recebe `'` na frente; campos com `";\n` são aspeados.
- Colunas: Nome, E-mail, Telefone, Assinatura, PIX (qtd), Valor PIX, Marca, 1º acesso, Último acesso, Status, Risco, Status contato.

---

## 5. Frontend (`app/`)

### Middleware `app/middleware/admin.ts`
```ts
export default defineNuxtRouteMiddleware(async (to) => {
  if (!to.path.startsWith('/admin') || to.path === '/admin/login') return
  try { await $fetch('/api/admin/me') } catch { return navigateTo('/admin/login') }
})
```
E no `auth.global.ts`, deixar `/admin` passar (a área tem guarda própria).

### `app/composables/useCountUp.ts`
Anima número de 0 ao alvo via `requestAnimationFrame`; respeita `prefers-reduced-motion`.

### `app/assets/css/admin-theme.css`
Tokens premium dark (variáveis `--adm-*`: paleta preto/ciano/dourado, sombras, glows, `--adm-ease`, aurora de fundo) + keyframes (`admin-fade-up`, `admin-shimmer`, `admin-glow-pulse`, `admin-bar-grow`, `admin-toast-timer`) + scrollbar dark + bloco `prefers-reduced-motion`. Importado nas 3 páginas via `<style>@import "~/assets/css/admin-theme.css";</style>`.

### `app/components/admin/ActivityChart.vue`
Gráfico de **área SVG**: `<linearGradient>` ciano, linha suave (Catmull-Rom → Bézier), pontos, guia/hover, linha de média pontilhada, toggle "Novos usuários / PIX gerados". Props: `{ days, loading, error }`.

### `app/pages/admin/index.vue` (o dashboard)

**Interfaces principais:**
```ts
interface AppUser {
  email: string; name: string | null; phone: string | null; brand_slug: string | null
  blocked: boolean; last_seen_at: string | null; first_seen_at: string | null
  subscription: 'paid' | 'free'; deposits_count: number; deposits_sum: number
  risk_tag: 'risk_24h'|'risk_48h'|'risk_no_access'|null
  auto_risk_tag: 'risk_24h'|'risk_48h'|'risk_no_access'|null
  tag_override: 'auto'|'none'|'risk_24h'|'risk_48h'|'risk_no_access'
  contact_status: 'pendente'|'contatado'|'respondeu'|'convertido'|'ignorado'
  source?: string
}
interface Stats { totalUsers; active48h; depositsCount; depositsSum; newToday; new7d; avgTicket; atRisk; conversionRate }
```

**Lógica-chave do script:**
- `fetchStats / fetchUsers(append) / fetchDeposits / fetchActivity` + `refreshAll`.
- Filtros (`search` com debounce 300ms; `riskFilter/subFilter/statusFilter/brandFilter` com `watch` → refaz a query).
- `useCountUp` em cada métrica; `avatarHue/avatarStyle` (cor por e-mail).
- **Status editável:** `updateStatus(u, value)` → POST `/users/status`, otimista.
- **Tag editável (manual manda):**
  ```ts
  const effectiveTag = (ov, auto) => ov === 'none' ? null : ov === 'auto' ? auto : ov
  const updateTag = async (u, value) => {
    const a=u.tag_override, b=u.risk_tag
    u.tag_override = value; u.risk_tag = effectiveTag(value, u.auto_risk_tag) // otimista
    try { await $fetch('/api/admin/users/tag', { method:'POST', body:{ email:u.email, tag:value } }); fetchStats() }
    catch { u.tag_override=a; u.risk_tag=b; showToast('Erro ao salvar tag','error') }
  }
  ```
- **FTD:** `registerFtd()` → POST `/api/admin/ftd` → toast + `Promise.all([fetchStats, fetchDeposits, fetchUsers])`.
- **Export CSV:** `exportCsv()` → `$fetch('/api/admin/users/export', { params:{...filtros}, responseType:'blob' })` → cria `<a download>`.
- **Bloqueio:** modal de confirmação + `confirmBlock()` → POST `/users/block`.
- Atalho `/` foca a busca; `Esc` fecha o modal.

**Tabela de usuários — colunas (na ordem):**
Usuário (avatar+nome+email) · Telefone (link `https://wa.me/<só dígitos>`) · **Tag** (`<select>` colorido por tag efetiva, opções: Automática / 24h / 48h+ / Pago nunca acessou / Sem tag) · **Contato** (`<select>` 5 etapas, colorido) · Assinatura (chip Pago/Free) · PIX (qtd + soma) · Marca · 1º acesso · Último acesso · Status (Ativo/Bloqueado) · ação (bloquear).

**Seções da página (na ordem):** topbar → título → 2 linhas de cards → ActivityChart → tabela Usuários (com filtros + export) → tabela Depósitos → **form Registrar FTD**.

### `app/pages/admin/login.vue` e `webhook.vue`
Login premium dark (card vidro, aurora, botão com glow). Webhook = textarea de e-mails → POST `/subscriptions/approve` + lista de resultados.

---

## 6. Ícones em produção (NÃO esquecer)

O app usa só ícones **Phosphor (`ph:`)**. Com `@nuxt/icon` em `serverBundle: 'remote'` e
sem coleção local, **os ícones são buscados na API da Iconify em runtime** — se o servidor
de produção não tiver internet de saída, somem. Para garantir:

```bash
npm install -D @iconify-json/ph
```
```ts
// nuxt.config.ts
icon: { serverBundle: 'local' }
```
Assim os ícones entram no bundle (zero chamada externa).

---

## 7. Checklist de adaptação pro Rainha

- [ ] Confirmar nomes das collections (`app_users`, `subscriptions`, `deposits`) e o **nome do DB** em `mongodb.ts`.
- [ ] Trocar `COOKIE_NAME` (`rainha_admin_session`) e os defaults de allowlist/senha/secret (idealmente via `.env`).
- [ ] Copiar os 2 utils + os 13 endpoints + middleware + composable + componente + `admin-theme.css`.
- [ ] Copiar `index.vue`, `login.vue`, `webhook.vue` e ajustar marca/cores se quiser.
- [ ] Garantir os campos esperados nas collections (ex.: `first_seen_at`/`last_seen_at` no `app_users` via heartbeat; `created_at`/`status` no `subscriptions`).
- [ ] Instalar `@iconify-json/ph` + `serverBundle: 'local'`.
- [ ] Conferir se o webhook Lastlink do Rainha grava `phone`/`name` (ver o doc do webhook) pra coluna Telefone preencher.
- [ ] `npx nuxt build` e validar com `curl` autenticado (login → stats → users → activity → export).

---

## 8. Prompt pronto pra colar (em outro assistente, dentro do projeto Rainha)

```
# Tarefa: criar um painel admin no app Rainha, igual ao do Irmandade Club

Contexto: Nuxt 4 (ssr:false) + Nitro + MongoDB + webhook Lastlink. Collections
app_users, subscriptions, deposits (mesmo padrão do Irmandade). Quero replicar o
painel admin descrito no documento PAINEL-ADMIN-RAINHA.md (que tenho em mãos).

Implemente, seguindo aquele documento:

1. server/utils/adminAuth.ts — sessão HMAC com expiração no servidor, comparação
   timing-safe, rate-limit no login, requireAdminSession. Troque COOKIE_NAME para
   'rainha_admin_session' e leia allowlist/senha/secret de .env.

2. server/utils/adminUserEnrichment.ts — buildUserEnrichmentStages (lookup de
   subscriptions+deposits+user_contact_status, assinatura, contagem/soma de PIX,
   contact_status, tag_override, auto_risk_tag e risk_tag efetivo onde o override
   manual manda) + buildSubsOnlyUnion (assinantes ativos sem app_users entram como
   usuários sintéticos). Use $literal/$ifNull no $project (valores nus viram exclusão).

3. Endpoints /api/admin/: login, logout, me, stats, users, users/block (upsert),
   users/status, users/tag, users/export (CSV ; + BOM + anti-injection), deposits,
   activity (14 dias), ftd (grava em deposits como PIX, is_ftd:true), subscriptions/approve.
   Todos com requireAdminSession (menos login/logout).

4. Frontend: middleware admin; composable useCountUp; assets/css/admin-theme.css
   (premium dark); components/admin/ActivityChart.vue (área SVG); pages admin/index.vue
   (dashboard com 8 cards animados, gráfico, tabela com colunas Telefone[WhatsApp],
   Tag[select editável], Contato[select editável], filtros, export CSV, bloqueio,
   form Registrar FTD), admin/login.vue, admin/webhook.vue.

5. Regra de risco: risk_24h/risk_48h (pago, 1º acesso após assinar, zero PIX, 24/48h)
   e risk_no_access (pago, nunca acessou, 24h de carência). Override manual (auto/none/
   tag) tem prioridade e afeta tabela, filtro, card "Em risco" e CSV.

6. Ícones: npm install -D @iconify-json/ph e icon.serverBundle = 'local' no nuxt.config.

Confirme os nomes das collections e o nome do banco antes. Ao final, rode nuxt build e
valide os endpoints com curl autenticado.
```

---

> Gerado a partir da implementação real do painel admin do Irmandade Club (2026-06-12).
> Arquivos de referência no projeto Irmandade: `server/utils/adminAuth.ts`,
> `server/utils/adminUserEnrichment.ts`, `server/api/admin/*`, `app/pages/admin/*`,
> `app/components/admin/ActivityChart.vue`, `app/assets/css/admin-theme.css`.
