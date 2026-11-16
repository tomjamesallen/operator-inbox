import type {
  InboxViewDto,
  QuestionBodyPartDto,
} from '@operator-inbox/core/api';
import { DrawingBlock, type DrawingHost } from './drawing-block';
import { HtmlBlock } from './html-block';
import { MermaidDiagram } from './mermaid-diagram';
import { RenderedBody } from './rendered-body';

// An inbox question's body. The server sends it as parts (core's
// `renderQuestionParts`): rendered markdown, each ```mermaid fence as its
// source, each `<Excalidraw id="…"/>` line as the id of one of the
// Question's drawings, and each `<Html id="…"/>` line as the id of one of its
// HTML blocks. Without parts, the body is its HTML alone.

type AnyQuestion =
  | InboxViewDto['awaitingOperator'][number]
  | InboxViewDto['awaitingAgent'][number]
  | InboxViewDto['processed'][number];

export const QuestionBody = ({
  question,
  className,
  drawingHost,
}: {
  readonly question: AnyQuestion;
  readonly className: string;
  // The question as its drawings need it: where their drafts are kept, and
  // whether they can still be edited. Without it they are shown read-only.
  readonly drawingHost?: DrawingHost | undefined;
}) => {
  const parts = question.bodyParts;
  if (parts === undefined)
    // Server-rendered HTML; see `RenderedBody` for the escaping promise it
    // rests on.
    return <RenderedBody html={question.bodyHtml} className={className} />;
  return (
    <div className={className}>
      {parts.map((part, i) => (
        // Parts never reorder, so the index is a stable key.
        <BodyPart key={i} part={part} question={question} host={drawingHost} />
      ))}
    </div>
  );
};

const BodyPart = ({
  part,
  question,
  host,
}: {
  readonly part: QuestionBodyPartDto;
  readonly question: AnyQuestion;
  readonly host: DrawingHost | undefined;
}) => {
  switch (part.kind) {
    case 'html':
      return <RenderedBody html={part.html} className="" />;
    case 'mermaid':
      return <MermaidDiagram source={part.source} />;
    case 'excalidraw':
      return (
        <DrawingBlock
          id={part.id}
          host={host}
          drawing={question.drawings?.[part.id]}
          sent={
            'sentDrawings' in question
              ? question.sentDrawings?.[part.id]
              : undefined
          }
        />
      );
    case 'html-block':
      return (
        <HtmlBlock
          id={part.id}
          width={part.width ?? 'constrain'}
          host={host}
          refs={question.htmls}
        />
      );
  }
};
