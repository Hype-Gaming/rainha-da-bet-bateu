# CI/CD — Deploy automático via GitHub Actions (repo privado)

Pipeline: todo push na `main` (ou **Run workflow** manual) faz o Actions abrir SSH na VPS,
puxar a `main`, buildar **na VPS** e recarregar o pm2. Workflow em
[.github/workflows/deploy.yml](../.github/workflows/deploy.yml).

```
push na main ──> GitHub Actions ──ssh──> VPS
                                          ├─ git reset --hard origin/main   (Deploy Key)
                                          ├─ npm ci
                                          ├─ npm run build
                                          └─ pm2 startOrReload ecosystem.config.cjs --update-env
```

São **duas chaves SSH diferentes** — não confunda:

| Chave | De → Para | Onde fica a privada | Onde fica a pública |
|---|---|---|---|
| **A** — deploy | Actions → VPS | Secret `VPS_SSH_KEY` no repo | `~/.ssh/authorized_keys` da VPS |
| **B** — Deploy Key | VPS → GitHub | `~/.ssh/id_ed25519` na VPS | **Deploy Key** (read-only) no repo |

---

## 0. Pré-requisitos na VPS (uma vez)

O build roda **na VPS**, então ela precisa de Node 20, pm2 e git **no PATH de sessão
não-interativa** (o Actions entra por SSH sem shell de login). Instale system-wide
(NodeSource), não via nvm — senão `node`/`pm2` somem no SSH do Actions.

```bash
# Node 20 LTS (NodeSource) — fica em /usr/bin, visível no PATH padrão
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git

# pm2 global
npm install -g pm2

# confere que aparecem num SSH não-interativo:
ssh root@SEU_IP 'which node npm pm2'   # tem que listar os 3 caminhos
```

> Se usar nvm assim mesmo, o workflow precisa de `source ~/.nvm/nvm.sh` antes dos comandos.
> Mais simples é o NodeSource acima.

---

## 1. Chave A — Actions → VPS

No **seu computador** (ou no Cloud Shell), gere um par dedicado ao deploy:

```bash
ssh-keygen -t ed25519 -C "actions-deploy-rainha" -f ~/.ssh/rainha_deploy -N ""
```

Coloque a **pública** na VPS (autoriza o Actions a entrar):

```bash
ssh-copy-id -i ~/.ssh/rainha_deploy.pub root@SEU_IP
# ou manualmente: cole o conteúdo de rainha_deploy.pub em ~/.ssh/authorized_keys da VPS
```

A **privada** (`~/.ssh/rainha_deploy`, arquivo inteiro, com `-----BEGIN...END-----`)
vai virar o secret `VPS_SSH_KEY` no passo 4.

Teste antes de seguir:
```bash
ssh -i ~/.ssh/rainha_deploy root@SEU_IP 'echo ok'
```

---

## 2. Chave B — VPS → GitHub (Deploy Key, repo privado)

Como o repo é **privado**, a VPS precisa de credencial pra fazer `git fetch`. Gere a chave
**na própria VPS**:

```bash
ssh root@SEU_IP
ssh-keygen -t ed25519 -C "vps-rainha-deploykey" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub      # copie esta linha
```

No GitHub: **repo → Settings → Deploy keys → Add deploy key**
- Title: `vps-rainha`
- Key: cole a pública
- **Allow write access: DESMARCADO** (deploy só lê)

Autorize o host do GitHub e teste (ainda na VPS):
```bash
ssh -T git@github.com    # responda "yes"; deve dizer "Hi Org/repo! You've successfully authenticated"
```

---

## 3. Clonar o repo na VPS (remote SSH)

O remote **precisa ser SSH** (`git@github.com:...`), senão a Deploy Key não é usada.

```bash
mkdir -p /var/www && cd /var/www
git clone git@github.com:ORG/REPO.git rainha-bet
cd rainha-bet

# criar o .env (NÃO vai pro git — gitignored). Mínimo pro código novo do Mongo:
#   MONGODB_URI=mongodb://admin:...@104.131.7.171:27017/?authSource=admin
#   MONGODB_DB=rainha-bateu
nano .env

# primeira subida manual (o workflow assume o app já existindo no pm2; startOrReload cobre, mas valide):
npm ci && npm run build
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
pm2 startup systemd -u root --hp /root   # se ainda não configurado nesta VPS
```

`VPS_PATH` (passo 4) = este caminho, ex.: `/var/www/rainha-bet`.

---

## 4. Secrets no repo

**repo → Settings → Secrets and variables → Actions → New repository secret:**

| Secret | Valor |
|---|---|
| `VPS_HOST` | IP/host da VPS (ex.: `203.0.113.10`) |
| `VPS_USER` | `root` (ou o usuário dono de `/var/www/rainha-bet`) |
| `VPS_SSH_KEY` | conteúdo **inteiro** da privada `~/.ssh/rainha_deploy` (chave A) |
| `VPS_PORT` | `22` |
| `VPS_PATH` | `/var/www/rainha-bet` |

> `VPS_SSH_KEY` é a chave **A** (Actions→VPS). A chave **B** (Deploy Key) **não** vira secret —
> ela vive só na VPS.

---

## 5. Rodar

- **Manual:** Actions → **Deploy** → **Run workflow** → branch `main`.
- **Automático:** todo push na `main` redeploya.

Acompanhe em **Actions**; o log mostra o build e o `pm2 startOrReload` na VPS.

---

## Troubleshooting

| Erro no log do Actions | Causa / correção |
|---|---|
| `Permission denied (publickey)` logo no SSH | Chave **A** errada no `VPS_SSH_KEY`, ou pública não está no `authorized_keys` da VPS. |
| `git@github.com: Permission denied` | Deploy Key (**B**) não configurada, remote não é SSH, ou repo errado. Teste `ssh -T git@github.com` na VPS. |
| `Host key verification failed` (GitHub) | Faltou aceitar o host na VPS: rode `ssh -T git@github.com` uma vez. |
| `npm: command not found` / `pm2: command not found` | Node/pm2 não estão no PATH do SSH não-interativo. Use NodeSource (passo 0), não nvm. |
| `pm2 reload ... not found` | Use `pm2 startOrReload` (já está no workflow) — cobre o 1º deploy. |
| App sobe mas `MONGODB_DB ausente` | `.env` da VPS sem `MONGODB_DB`/`MONGODB_URI` — ver passo 3. |
