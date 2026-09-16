import { memo } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"

export default memo(function MinutesMarkdown({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        img: () => null,
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
        table: ({ children }) => (
          <div className="minutes-table">
            <table>{children}</table>
          </div>
        ),
      }}
    >
      {text}
    </Markdown>
  )
})
