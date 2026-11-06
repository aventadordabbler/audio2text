import { useState, type FormEvent } from "react"
import { AudioLines, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api, errorMessage, setAuthToken } from "@/lib/meetings"

interface Props {
  onAuthenticated: (user: Record<string, unknown>) => void
}

export function AuthScreen({ onAuthenticated }: Props) {
  const [registering, setRegistering] = useState(false)
  const [account, setAccount] = useState("")
  const [password, setPassword] = useState("")
  const [department, setDepartment] = useState("")
  const [employeeId, setEmployeeId] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    setNotice("")
    try {
      if (registering) {
        await api("/api/auth/register", { method: "POST", body: JSON.stringify({ account, password, department, employee_id: employeeId }), headers: { "Content-Type": "application/json" } })
        setRegistering(false)
        setPassword("")
        setDepartment("")
        setEmployeeId("")
        setNotice("注册成功，请登录")
        return
      }
      const result = await api<{ token: string; user: Record<string, unknown> }>("/api/auth/login", { method: "POST", body: JSON.stringify({ account, password }), headers: { "Content-Type": "application/json" } })
      setAuthToken(result.token)
      onAuthenticated(result.user)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-screen">
      <form className="auth-panel" onSubmit={submit}>
        <div className="auth-brand"><span><AudioLines /></span><div><strong>会议助手</strong><small>登录后管理会议</small></div></div>
        <div className="auth-tabs"><button type="button" className={!registering ? "active" : ""} onClick={() => { setRegistering(false); setNotice("") }}>登录</button><button type="button" className={registering ? "active" : ""} onClick={() => { setRegistering(true); setNotice("") }}>注册</button></div>
        <Label className="auth-field"><span>账号{registering && <i className="required-mark" aria-hidden="true">*</i>}</span><Input value={account} onChange={(event) => setAccount(event.target.value)} maxLength={60} required disabled={busy} /></Label>
        <Label className="auth-field"><span>密码{registering && <i className="required-mark" aria-hidden="true">*</i>}</span><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={registering ? 8 : 0} maxLength={128} required={registering} disabled={busy} /></Label>
        {registering && <>
          <Label className="auth-field"><span>部门<i className="required-mark" aria-hidden="true">*</i></span><Input value={department} onChange={(event) => setDepartment(event.target.value)} maxLength={60} required disabled={busy} /></Label>
          <Label className="auth-field"><span>工号<i className="required-mark" aria-hidden="true">*</i></span><Input value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} maxLength={60} required disabled={busy} /></Label>
        </>}
        {notice && <p className="auth-success" role="status">{notice}</p>}
        {error && <p className="auth-error" role="alert">{error}</p>}
        <Button type="submit" className="auth-submit" disabled={busy}>{busy && <LoaderCircle className="animate-spin" />} {registering ? "注册" : "登录"}</Button>
      </form>
    </main>
  )
}

export function PasswordChangeScreen({ user, onChanged }: { user: Record<string, unknown>; onChanged: (user: Record<string, unknown>) => void }) {
  const [password, setPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (password !== confirmation) { setError("两次输入的密码不一致"); return }
    setBusy(true); setError("")
    try {
      const result = await api<{ user: Record<string, unknown> }>("/api/auth/password", {
        method: "POST", body: JSON.stringify({ password }), headers: { "Content-Type": "application/json" },
      })
      onChanged(result.user)
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy(false) }
  }

  return <main className="auth-screen"><form className="auth-panel" onSubmit={submit}>
    <div className="auth-brand"><span><AudioLines /></span><div><strong>首次登录</strong><small>请先设置管理员密码</small></div></div>
    <p className="auth-help">管理员当前使用默认空密码，请设置一个新的登录密码。</p>
    <Label className="auth-field"><span>新密码</span><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} maxLength={128} required disabled={busy} autoFocus /></Label>
    <Label className="auth-field"><span>确认密码</span><Input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={8} maxLength={128} required disabled={busy} /></Label>
    {error && <p className="auth-error" role="alert">{error}</p>}
    <Button type="submit" className="auth-submit" disabled={busy}>{busy && <LoaderCircle className="animate-spin" />}保存新密码</Button>
  </form></main>
}
