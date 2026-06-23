import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const NO_STORE_PATHS = ['/login', '/register', '/']

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const response = NextResponse.next()

  if (NO_STORE_PATHS.includes(pathname)) {
    response.headers.set('Cache-Control', 'no-store')
  }

  return response
}

export const config = {
  matcher: ['/login', '/register', '/'],
}
