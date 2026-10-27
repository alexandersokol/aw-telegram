"""Generate the checked-in declarative schemas from compact definitions."""
import json
from pathlib import Path

DEST = Path(__file__).resolve().parent / 'v1'
DEST.mkdir(parents=True, exist_ok=True)
BASE = 'https://aw-telegram.invalid/contracts/v1/'
def ref(name): return {'$ref': BASE + 'shared.schema.json#/$defs/' + name}
def obj(properties): return {'type':'object','properties':properties,'required':list(properties),'additionalProperties':False}
def string(lo=1, hi=1000): return {'type':'string','minLength':lo,'maxLength':hi}
def array(items, hi, lo=0): return {'type':'array','items':items,'minItems':lo,'maxItems':hi}
def nullable(s): return {'anyOf':[s,{'type':'null'}]}
def integer(lo=0,hi=9007199254740991): return {'type':'integer','minimum':lo,'maximum':hi}
def literal(v): return {'const':v}
def save(name,schema):
    schema = {'$schema':'http://json-schema.org/draft-07/schema#','$id':BASE+name+'.schema.json',**schema}
    (DEST / (name+'.schema.json')).write_text(json.dumps(schema,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    package = DEST.parents[1] / 'companion' / 'src' / 'aw_telegram' / 'schemas'
    package.mkdir(parents=True, exist_ok=True)
    (package / (name+'.schema.json')).write_text(json.dumps(schema,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

defs = {
 'Counter':integer(), 'DurationMs':integer(),
 'LocalDate':{'type':'string','format':'local-date','pattern':'^(?:19[7-9][0-9]|20[0-9]{2})-[0-9]{2}-[0-9]{2}$'},
 'Instant':{'type':'string','format':'utc-instant'},
 # Unlike $, this portable assertion cannot match before a final line ending.
 'TelegramId':{'type':'string','pattern':r'^[1-9][0-9]{0,19}(?![\s\S])'},
 'Uuid':{'type':'string','pattern':r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])'},
 'CategoryPath':array(string(1,256),16,1), 'Message':string(),
 # 16 * (256 * 6 + 2) + 15 commas + 2 brackets: worst JSON escaped path.
 'CategoryRef':obj({'id':string(1,24625),'path':nullable(ref('CategoryPath'))}),
 'LeafTotal':obj({'category':ref('CategoryRef'),'totalMs':ref('DurationMs')}),
 'Settings':obj({'revision':ref('Counter'),'selectedPaths':array(ref('CategoryPath'),256),
    'selectedUncategorized':{'type':'boolean'},'defaultLimitMs':ref('DurationMs'),
    'todayOverride':nullable(obj({'date':ref('LocalDate'),'limitMs':ref('DurationMs')})),
    'freeUseDate':nullable(ref('LocalDate')),'suppressedDate':nullable(ref('LocalDate'))}),
 'DaySummary':obj({'date':ref('LocalDate'),'leafTotalsMs':array(ref('LeafTotal'),1024),
    'totalActiveMs':ref('DurationMs'),'selectedTotalMs':ref('DurationMs'),'settingsRevision':ref('Counter'),
    'rulesRevision':string(1,128),'availableFrom':nullable(ref('Instant')),'availableThrough':nullable(ref('Instant')),
    'partial':{'type':'boolean'},'sequence':ref('Counter')}),
 'LiveState':obj({'observedAt':ref('Instant'),'state':{'enum':['active','afk','unknown']},
    'app':nullable(string(1,256)),'title':nullable(string(0,1000)),'category':nullable(ref('CategoryRef')),
    'rulesRevision':nullable(string(1,128)),'categoryCatalog':array(ref('CategoryRef'),1024)}),
 'Cancellations':obj({'revision':ref('Counter'),'throughActionSequence':ref('Counter'),'canceledIds':array(ref('Uuid'),100)}),
}
common = {'id':ref('Uuid'),'actorId':ref('TelegramId'),'createdAt':ref('Instant'),
    'targetAt':ref('Instant'),'expiresAt':ref('Instant'),'sequence':ref('Counter'),'settingsRevision':ref('Counter')}
presentation={'message':ref('Message'),'countdown':{'type':'boolean'}}
defs['Action']={'oneOf':[
 obj({**common,'kind':literal('notify'),'options':obj(presentation)}),
 obj({**common,'kind':literal('overlay'),'options':{'oneOf':[
   obj({**presentation,'dismissible':literal(True),'repeatEveryMinutes':nullable(integer(1,1439))}),
   obj({**presentation,'dismissible':literal(False),'durationSeconds':integer(1,3600)})]}})]}
defs['Ack']={'oneOf':[
 obj({'id':ref('Uuid'),'kind':literal('settings'),'revision':ref('Counter'),'appliedAt':ref('Instant')}),
 obj({'id':ref('Uuid'),'kind':literal('cancellation'),'revision':ref('Counter'),'throughActionSequence':ref('Counter'),'appliedAt':ref('Instant')}),
 obj({'id':ref('Uuid'),'kind':literal('action'),'actionId':ref('Uuid'),'eventSequence':ref('Counter'),
      'occurrence':ref('Counter'),'status':{'enum':['accepted','presenting','presented','dismissed','completed','replaced','expired','skipped','canceled','failed','unconfirmed']},
      'at':ref('Instant'),'acceptedAt':nullable(ref('Instant')),'presentedAt':nullable(ref('Instant')),
      'reason':nullable({'enum':['display_busy','free_use','missed_deadline','canceled','replaced','presentation_blocked','presentation_failed','crash_during_presentation']})})]}
save('shared', {'$defs':defs})
for name,definition in [('settings','Settings'),('day','DaySummary'),('action','Action'),('ack','Ack'),('live','LiveState'),('cancellations','Cancellations')]:
    save(name,ref(definition))
request=obj({'schemaVersion':literal(1),'sequence':ref('Counter'),'summaries':array(ref('DaySummary'),7),
             'live':ref('LiveState'),'acks':array(ref('Ack'),100)})
request['required']=['schemaVersion','sequence','acks']
save('sync-request',request)
save('sync-response',obj({'schemaVersion':literal(1),'requestSequence':ref('Counter'),'serverNow':ref('Instant'),
    'collectionStartedAt':nullable(ref('Instant')),'settings':ref('Settings'),'cancellations':ref('Cancellations'),
    'deliveryOffers':array(ref('Action'),100),'acknowledgedAckIds':array(ref('Uuid'),100)}))
