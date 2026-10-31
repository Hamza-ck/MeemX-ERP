import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({ error: 'Server environment not properly configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 1. Verify caller session using caller's JWT
    const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const {
      data: { user: callerUser },
      error: userError,
    } = await callerClient.auth.getUser()

    if (userError || !callerUser) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired caller session' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Only administrators manage accounts. (This used to demand role = 'owner', but owners are
    // read-only and cannot reach the user screen, so nobody could ever create a user.)
    const { data: callerProfile, error: profileError } = await callerClient
      .from('profiles')
      .select('role')
      .eq('id', callerUser.id)
      .maybeSingle()

    if (profileError || callerProfile?.role !== 'admin') {
      return new Response(
        JSON.stringify({ error: 'Unauthorized: Only an administrator can create new users' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 2. Parse request payload
    const body = await req.json().catch(() => ({}))
    const { email, password, role, fullName } = body

    if (!email || typeof email !== 'string' || !email.trim()) {
      return new Response(
        JSON.stringify({ error: 'Valid email is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!password || typeof password !== 'string' || password.length < 6) {
      return new Response(
        JSON.stringify({ error: 'Password must be at least 6 characters' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Honour the requested role (admin | owner | employee). It used to collapse everything that
    // was not 'owner' into 'employee', so an Admin could never be created. Unknown values are
    // rejected rather than guessed, and the safe default is read-only.
    if (role !== undefined && !['admin', 'owner', 'employee'].includes(role)) {
      return new Response(
        JSON.stringify({ error: 'Role must be admin, owner or employee' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    const assignedRole = role ?? 'owner'

    // 3. Admin client with elevated service role
    const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    // Create user in Auth
    const { data: newUserData, error: createError } = await adminClient.auth.admin.createUser({
      email: email.trim(),
      password: password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName?.trim() || '',
        role: assignedRole,
      },
    })

    if (createError || !newUserData?.user) {
      return new Response(
        JSON.stringify({ error: createError?.message || 'Failed to create user in Auth' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const createdUserId = newUserData.user.id

    // Upsert into profiles table with chosen role
    const { error: upsertError } = await adminClient.from('profiles').upsert({
      id: createdUserId,
      role: assignedRole,
      full_name: fullName?.trim() || email.trim().split('@')[0],
    })

    if (upsertError) {
      // Do not leave a login without a profile behind: it could never sign in and blocks the email.
      await adminClient.auth.admin.deleteUser(createdUserId)
      return new Response(
        JSON.stringify({ error: `Could not create the profile, so the account was rolled back: ${upsertError.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({
        success: true,
        user: {
          id: createdUserId,
          email: newUserData.user.email,
          role: assignedRole,
          full_name: fullName?.trim() || '',
        },
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
