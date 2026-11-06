import { AudioLines, FileText } from "lucide-react";

export function WorkspaceBrand() {
  return (
    <div className="workspace-brand">
      <span className="brand-mark">
        <AudioLines size={22} strokeWidth={1.7} />
      </span>
      <div>
        <strong>会议助手</strong>
        <small>桌面端</small>
      </div>
    </div>
  );
}

export function EmptyDocument({
  icon: Icon = FileText,
  iconClassName,
  title,
  description,
  children,
}) {
  return (
    <div className="document-empty">
      <div className="document-empty-icon">
        <Icon size={26} strokeWidth={1.5} className={iconClassName} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children || (
        <div className="empty-document-lines" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      )}
    </div>
  );
}

export function RecordingWave({ active }) {
  return (
    <div className={`audio-wave${active ? " active" : ""}`} aria-hidden="true">
      {[
        12, 20, 13, 28, 19, 34, 25, 40, 30, 20, 37, 28, 44, 26, 34, 18, 30, 21,
        13, 24, 12,
      ].map((height, index) => (
        <i
          key={index}
          style={{ height, animationDelay: `${index * -0.13}s` }}
        />
      ))}
    </div>
  );
}
