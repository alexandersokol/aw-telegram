/** Framework-neutral router plus bounded Node HTTP adapter. No implicit server or credential loading. */
import type {IncomingMessage,ServerResponse} from 'node:http';
import {MAX_BODY_BYTES} from './contracts.js';
import {authorizeDevice} from './auth.js';
import {enroll,envelope} from './enrollment.js';
import {BoundaryError,type FirestoreRepository} from './repository.js';
export interface HttpRequest {method:string;path:string;headers:Record<string,string|string[]|undefined>;body:string|Uint8Array;remoteAddress:string}
export interface HttpResponse {status:number;headers:Record<string,string>;body?:any}
export function createRouter(repository: FirestoreRepository) {
  return async (request: HttpRequest): Promise<HttpResponse> => {
    const headers:Record<string,string>={'Cache-Control':'no-store','Content-Type':'application/json','X-Content-Type-Options':'nosniff'};
    try {
      if(!request.path.startsWith('/') || request.path.startsWith('//') || /[\\\x00-\x20#]/.test(request.path)) throw new BoundaryError('Invalid request');
      if(Buffer.byteLength(request.body)>MAX_BODY_BYTES) throw new BoundaryError('Invalid request',413);
      if(request.method==='POST' && request.path==='/v1/enroll') return {status:200,headers,body:await enroll(repository,request.body,request.remoteAddress)};
      const url=new URL(request.path,'https://local.invalid');
      const identity=await authorizeDevice({authorization:request.headers.authorization},repository);
      if(request.method==='POST' && request.path==='/v1/pair-keys') return {status:201,headers,body:await repository.createPairKey(identity,envelope(request.body,'name'))};
      if(request.method==='GET' && url.pathname==='/v1/access') {
        if(request.body.length || [...url.searchParams.keys()].some(k=>k!=='page') || url.searchParams.getAll('page').length>1) throw new BoundaryError('Invalid request');
        const page=url.searchParams.get('page');
        return {status:200,headers,body:await repository.listAccess(identity,page===null?undefined:page)};
      }
      if(request.method==='DELETE' && request.path.startsWith('/v1/access/')) {
        if(request.body.length || url.search || request.path.slice(11).includes('/')) throw new BoundaryError('Invalid request');
        await repository.revokeAccess(identity,request.path.slice('/v1/access/'.length)); return {status:204,headers};
      }
      return {status:404,headers,body:{error:'Not found'}};
    } catch(error) {
      if(error instanceof BoundaryError) {
        if(error.retryAfter) headers['Retry-After']=String(error.retryAfter);
        return {status:error.status,headers,body:{error:error.message}};
      }
      return {status:500,headers,body:{error:'Request failed'}};
    }
  };
}
export function createHttpHandler(repository: FirestoreRepository) {
  const router=createRouter(repository);
  return async (request:IncomingMessage,response:ServerResponse):Promise<void>=>{
    let size=0; const chunks:Buffer[]=[];
    try {
      for await (const chunk of request) {
        size+=Buffer.byteLength(chunk); if(size>MAX_BODY_BYTES) {response.writeHead(413,{'Cache-Control':'no-store','Connection':'close'});response.end();return;} chunks.push(Buffer.from(chunk));
      }
      const count=request.rawHeaders.filter((_,i)=>i%2===0 && request.rawHeaders[i]!.toLowerCase()==='authorization').length;
      const headers={...request.headers}; if(count>1) headers.authorization='';
      const result=await router({method:request.method??'',path:request.url??'',headers,body:Buffer.concat(chunks),remoteAddress:request.socket.remoteAddress??''});
      response.writeHead(result.status,result.headers); response.end(result.body===undefined?undefined:JSON.stringify(result.body));
    } catch {if(!response.headersSent) response.writeHead(400,{'Cache-Control':'no-store'});response.end();}
  };
}
