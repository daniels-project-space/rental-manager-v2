import {describe,it,expect} from 'vitest';
import {orderedReplyMessages} from './reply_message_order';
describe('real reply chronology',()=>{
 it('keeps a sent reply latest when old renter history was inserted later',()=>{
  const rows=[{message_id:'old-renter',sender:'renter',hygglo_sent_at:10,fetched_at:500},{message_id:'owner',sender:'owner',hygglo_sent_at:100,fetched_at:100}];
  expect(orderedReplyMessages(rows)[0].sender).toBe('owner');expect(rows[0].sender).toBe('renter');
 });
 it('restores priority after a genuinely newer renter message',()=>{
  const rows=[{message_id:'owner',sender:'owner',hygglo_sent_at:100,fetched_at:500},{message_id:'new-renter',sender:'renter',hygglo_sent_at:101,fetched_at:101}];
  expect(orderedReplyMessages(rows)[0].sender).toBe('renter');
 });
 it('handles absent and invalid provider times',()=>{
  expect(orderedReplyMessages([{message_id:'a',fetched_at:10},{message_id:'b',hygglo_sent_at:NaN,fetched_at:20}])[0].message_id).toBe('b');
 });
});
