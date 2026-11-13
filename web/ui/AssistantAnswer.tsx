import {ArrowUpRight} from 'lucide-react';
import {answerSections,linkParts} from './assistant-reading.mjs';

function Lines({lines}:{lines:string[]}){
  return lines.map((line,i)=><p key={i}>{(linkParts(line) as {text:string;url?:string}[]).map((part,j)=>part.url?
    <a key={j} href={part.url} target="_blank" rel="noreferrer">{part.text}</a>:part.text)}</p>);
}

export function Answer({text,deep=false,contractTitle}:{text:string;deep?:boolean;contractTitle?:string}){
  const {sections,sources}=answerSections(text,{contractTitle});
  const [lead,...more]=sections;
  return <div className="answer">
    {lead&&<section className="answer-lead"><h3>{lead.title}</h3><Lines lines={lead.lines}/></section>}
    {more.length>0&&<details className="answer-details" open={deep||undefined}><summary>Read the reasoning <small>{more.length} {more.length===1?'section':'sections'}</small></summary>
      {more.map(({title,lines},i)=><section className="answer-step" key={i}><h3>{title}</h3><Lines lines={lines}/></section>)}
    </details>}
    {sources.length>0&&<details className="answer-details"><summary>Open source links <small>{sources.length}</small></summary><ul className="answer-sources">
      {sources.map(row=><li key={row.url}><a href={row.url} target="_blank" rel="noreferrer">{row.text}<ArrowUpRight size={13}/></a></li>)}
    </ul></details>}
  </div>;
}
