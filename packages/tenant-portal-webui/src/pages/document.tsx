export function DocumentPage(props: { documentId: string; threadId?: string; pingIdx?: number }) {
  return <h1>{props.documentId}</h1>;
}
