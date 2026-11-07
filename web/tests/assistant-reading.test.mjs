import test from 'node:test';
import assert from 'node:assert/strict';
import {answerSections,linkParts} from '../ui/assistant-reading.mjs';

test('the first answer keeps its conclusion above details and deduplicates the source tray',()=>{
  const answer='New York wins (KXNFLGAME-26NOV08NYGPHI-NYG)\n\n## The short answer\nThe observed ask is 60 cents.\n\n## Why that matters\nFees raise the entry cost.\n\nSources checked: [Rules](https://example.org/rules), [Book](https://example.org/book), [Rules](https://example.org/rules)';
  const result=answerSections(answer);
  assert.deepEqual(result.sections,[
    {title:'The short answer',lines:['The observed ask is 60 cents.']},
    {title:'Why that matters',lines:['Fees raise the entry cost.']}
  ]);
  assert.deepEqual(result.sources.map(row=>row.url),['https://example.org/rules','https://example.org/book']);
});

test('partially streamed citations remain readable and unsafe URLs remain plain text',()=>{
  const incomplete='[Book](https://example.org/bo';
  assert.deepEqual(linkParts(incomplete),[{text:incomplete}]);
  const unsafe='[Report](https://user:pass@example.org/report)';
  assert.deepEqual(linkParts(unsafe),[{text:unsafe}]);
  assert.deepEqual(answerSections('Sources checked: '+incomplete).sections[0].lines,['Sources checked: '+incomplete]);
});

test('an exact contract-title preamble cannot hide the substantive answer in brief mode',()=>{
  const content='Arizona wins\n\n## The short answer\nThe model prices a tie separately.\n\n## The price\nCompare both asks after fees.';
  assert.deepEqual(answerSections(content,{contractTitle:'Arizona wins'}).sections[0],{title:'The short answer',lines:['The model prices a tie separately.']});
  assert.deepEqual(answerSections('Arizona wins',{contractTitle:'Arizona wins'}).sections[0].lines,['Arizona wins']);
  assert.deepEqual(answerSections('Arizona wins would cost 23 cents.\n\n## The price\nCompare fees.',{contractTitle:'Arizona wins'}).sections[0].lines,['Arizona wins would cost 23 cents.']);
});
