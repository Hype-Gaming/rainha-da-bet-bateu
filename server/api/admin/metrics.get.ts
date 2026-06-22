import { requireAdmin } from '../../utils/admin'
import { getDb } from '../../utils/mongodb'
import { panelBrandMatch } from '../../utils/adminUserEnrichment'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)

  const db = await getDb()
  const subs = db.collection('subscriptions')
  const requests = db.collection('access_requests')

  // subscriptions/access_requests não são taggeadas hoje (brand null) → o filtro
  // mantém tudo como bateu; se um dia receberem marca estrangeira, já as exclui.
  const brandFilter = panelBrandMatch()
  const [active, inactive, pending] = await Promise.all([
    subs.countDocuments({ ...brandFilter, status: 'active' }),
    subs.countDocuments({ ...brandFilter, status: 'inactive' }),
    requests.countDocuments({ ...brandFilter, status: 'pending' })
  ])

  return { active, inactive, pending }
})
