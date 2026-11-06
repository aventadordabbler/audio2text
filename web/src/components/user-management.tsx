import { useState } from "react"
import { LoaderCircle, ShieldCheck, ShieldOff, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, errorMessage, type UserAccount } from "@/lib/meetings"

export function UserManagement({ users, onChanged }: {
  users: UserAccount[]
  onChanged: () => Promise<void>
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState("")

  async function toggle(user: UserAccount) {
    if (user.is_admin || busyId) return
    setBusyId(user.id)
    setError("")
    try {
      await api<UserAccount>(`/api/users/${user.id}/department-admin`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !user.is_department_admin }),
      })
      await onChanged()
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="page-content animate-page-in">
      <div className="page-heading">
        <div>
          <h1>用户管理</h1>
          <p>管理用户账号及部门管理员授权。</p>
        </div>
      </div>
      {error && <p className="management-error" role="alert">{error}</p>}
      <Card className="meeting-table-card gap-0 overflow-hidden rounded-xl py-0 shadow-none">
        <Table>
          <TableHeader><TableRow className="bg-muted/45 hover:bg-muted/45"><TableHead>账号</TableHead><TableHead>工号</TableHead><TableHead>所属部门</TableHead><TableHead>角色</TableHead><TableHead className="w-28 text-right">操作</TableHead></TableRow></TableHeader>
          <TableBody>
            {users.map((user) => {
              const role = user.is_admin ? "系统管理员" : user.is_department_admin ? "部门管理员" : "普通用户"
              return <TableRow key={user.id} className="meeting-row">
                <TableCell className="text-center"><span className="flex items-center justify-center gap-2"><Users className="size-4 text-muted-foreground" />{user.account}</span></TableCell>
                <TableCell className="text-muted-foreground">{user.employee_id}</TableCell>
                <TableCell>{user.department_name}</TableCell>
                <TableCell><span className={user.is_admin || user.is_department_admin ? "font-medium text-foreground" : "text-muted-foreground"}>{role}</span></TableCell>
                <TableCell className="text-right"><Button type="button" variant="ghost" size="icon-sm" disabled={user.is_admin || busyId !== null} aria-label={user.is_department_admin ? `撤销${user.account}的部门管理员授权` : `授予${user.account}部门管理员授权`} title={user.is_admin ? "系统管理员不可修改" : user.is_department_admin ? "撤销部门管理员授权" : "授予部门管理员授权"} onClick={() => void toggle(user)}>{busyId === user.id ? <LoaderCircle className="animate-spin" /> : user.is_department_admin ? <ShieldOff /> : <ShieldCheck />}</Button></TableCell>
              </TableRow>
            })}
            {!users.length && <TableRow className="hover:bg-transparent"><TableCell colSpan={5}><div className="empty-state"><Users className="mb-4 size-8 text-neutral-400" /><h3>还没有用户</h3><p>用户注册后会显示在这里。</p></div></TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>
    </section>
  )
}
