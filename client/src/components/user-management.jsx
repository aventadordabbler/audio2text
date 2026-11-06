import { useState } from "react";
import { LoaderCircle, ShieldCheck, ShieldOff, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function UserManagement({ api, users, loading, onChanged }) {
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  async function toggle(user) {
    if (!api || user.is_admin || busyId) return;
    setBusyId(user.id);
    setError("");
    try {
      await api.setDepartmentAdmin(user.id, !user.is_department_admin);
      await onChanged();
    } catch (toggleError) {
      setError(toggleError.message);
    } finally {
      setBusyId("");
    }
  }

  return (
    <section className="page-content management-page">
      <div className="page-heading">
        <div>
          <h1>用户管理</h1>
          <p>管理用户账号及部门管理员授权。</p>
        </div>
      </div>
      {!api && <div className="management-error">请先配置会议服务地址。</div>}
      {error && <div className="management-error" role="alert">{error}</div>}
      <Card className="history-table-card">
        <div className="history-table-scroll panel-scroll management-table">
          <Table>
            <TableHeader><TableRow><TableHead>账号</TableHead><TableHead>工号</TableHead><TableHead>所属部门</TableHead><TableHead>角色</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {users.map((user) => {
                const role = user.is_admin ? "系统管理员" : user.is_department_admin ? "部门管理员" : "普通用户";
                return <TableRow key={user.id}>
                  <TableCell><span className="department-name"><Users size={15} />{user.account}</span></TableCell>
                  <TableCell>{user.employee_id}</TableCell>
                  <TableCell>{user.department_name}</TableCell>
                  <TableCell className={user.is_admin || user.is_department_admin ? "" : "text-muted-foreground"}>{role}</TableCell>
                  <TableCell><Button type="button" variant="ghost" size="icon" disabled={user.is_admin || loading || Boolean(busyId)} aria-label={user.is_department_admin ? `撤销${user.account}的部门管理员授权` : `授予${user.account}部门管理员授权`} title={user.is_admin ? "系统管理员不可修改" : user.is_department_admin ? "撤销部门管理员授权" : "授予部门管理员授权"} onClick={() => void toggle(user)}>{busyId === user.id ? <LoaderCircle className="animate-spin" /> : user.is_department_admin ? <ShieldOff size={15} /> : <ShieldCheck size={15} />}</Button></TableCell>
                </TableRow>;
              })}
              {!users.length && <TableRow><TableCell colSpan={5}><div className="empty-state"><Users /><h3>{loading ? "正在加载用户" : "还没有用户"}</h3><p>{loading ? "" : "用户注册后会显示在这里。"}</p></div></TableCell></TableRow>}
            </TableBody>
          </Table>
        </div>
      </Card>
    </section>
  );
}
