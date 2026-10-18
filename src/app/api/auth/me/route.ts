import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'

export async function GET() {
  try {
    const user = await getSessionUser()
    return NextResponse.json({ user })
  } catch (e) {
    return handleError(e)
  }
}
