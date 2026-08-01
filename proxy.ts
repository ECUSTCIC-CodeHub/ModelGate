import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const NO_STORE_PATHS = ['/login', '/register', '/']

const AUTH_DISABLED = process.env.AUTH_DISABLED === '1' || process.env.AUTH_DISABLED === 'true'
// 与 lib/auth/auth.ts 的 ACCESS_COOKIE_NAME / REFRESH_COOKIE_NAME 保持同步
const ACCESS_COOKIE = 'vlm-access-token'
const REFRESH_COOKIE = 'vlm-refresh-token'
const REQUEST_PATH_HEADER = 'x-request-path'

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set(REQUEST_PATH_HEADER, pathname + search)

  if (
    pathname.startsWith('/dashboard') &&
    !AUTH_DISABLED &&
    !request.cookies.has(ACCESS_COOKIE) &&
    !request.cookies.has(REFRESH_COOKIE)
  ) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', pathname + search)
    return NextResponse.redirect(loginUrl, 302)
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } })

  if (NO_STORE_PATHS.includes(pathname)) {
    response.headers.set('Cache-Control', 'no-store')
  }

  return response
}

export const config = {
  matcher: ['/login', '/register', '/', '/dashboard/:path*'],
}
