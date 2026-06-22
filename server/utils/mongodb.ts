import { MongoClient, type Db } from 'mongodb'

let client: MongoClient | null = null
let db: Db | null = null

export const getDb = async (): Promise<Db> => {
  if (db) return db

  // Sem fallback: a marca define seu próprio banco via .env. Faltando qualquer
  // uma das vars, falha de propósito (não cai num banco compartilhado errado).
  const uri = process.env.MONGODB_URI
  const dbName = process.env.MONGODB_DB
  if (!uri) throw new Error('MONGODB_URI ausente — configure no .env')
  if (!dbName) throw new Error('MONGODB_DB ausente — configure no .env')

  client = new MongoClient(uri)
  await client.connect()
  db = client.db(dbName)

  return db
}
