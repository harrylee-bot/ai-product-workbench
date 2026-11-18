import { parseLimit } from '../threads/threads.controller.js';
import { Body,Controller,Get,Headers,HttpCode,Param,Post,Query,Res,UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { createRequirementSessionRequestSchema,postRequirementMessageRequestSchema,confirmRequirementRequestSchema } from '@workbench/workbench-contracts';
import { parseIfMatch,revisionEtag } from '../../common/http-preconditions.js';
import { validationProblem } from '../../common/problem-details.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentPrincipal } from '../identity/current-principal.decorator.js';
import type { AuthenticatedPrincipal } from '../identity/identity.types.js';
import { WorkbenchAuthGuard } from '../identity/workbench-auth.guard.js';
import { RequirementsService } from './requirements.service.js';
import type { z } from 'zod';
const key=(value:string|undefined)=>{if(!value)throw validationProblem('Idempotency-Key is required');return value;};
@Controller()
@UseGuards(WorkbenchAuthGuard)
export class RequirementsController {
 constructor(private readonly sessions:RequirementsService){}
 @Get('threads/:threadId/requirement-sessions')
 list(@CurrentPrincipal() p:AuthenticatedPrincipal,@Param('threadId') threadId:string,@Res({passthrough:true}) response:Response,@Query('cursor') cursor?:string,@Query('limit') limit?:string){response.setHeader('Cache-Control','private, no-store');return this.sessions.list(p.id,threadId,cursor,parseLimit(limit,100));}
 @Post('threads/:threadId/requirement-sessions')
 async create(@CurrentPrincipal() p:AuthenticatedPrincipal,@Param('threadId') threadId:string,@Headers('idempotency-key') k:string|undefined,@Body(new ZodValidationPipe(createRequirementSessionRequestSchema)) body:z.infer<typeof createRequirementSessionRequestSchema>,@Res({passthrough:true}) response:Response){return this.reply(response,await this.sessions.create(p.id,threadId,key(k),body.generationRequest,body.context));}
 @Get('requirement-sessions/:sessionId')
 async get(@CurrentPrincipal() p:AuthenticatedPrincipal,@Param('sessionId') sessionId:string,@Res({passthrough:true}) response:Response){return this.reply(response,await this.sessions.get(p.id,sessionId));}
 @Post('requirement-sessions/:sessionId/messages') @HttpCode(202)
 async message(@CurrentPrincipal() p:AuthenticatedPrincipal,@Param('sessionId') id:string,@Headers('idempotency-key') k:string|undefined,@Headers('if-match') tag:string|undefined,@Body(new ZodValidationPipe(postRequirementMessageRequestSchema)) body:z.infer<typeof postRequirementMessageRequestSchema>,@Res({passthrough:true}) response:Response){return this.reply(response,await this.sessions.message(p.id,id,key(k),parseIfMatch(tag),body));}
 @Post('requirement-sessions/:sessionId/confirm') @HttpCode(202)
 async confirm(@CurrentPrincipal() p:AuthenticatedPrincipal,@Param('sessionId') id:string,@Headers('idempotency-key') k:string|undefined,@Headers('if-match') tag:string|undefined,@Body(new ZodValidationPipe(confirmRequirementRequestSchema)) body:z.infer<typeof confirmRequirementRequestSchema>,@Res({passthrough:true}) response:Response){return this.reply(response,await this.sessions.confirm(p.id,id,key(k),parseIfMatch(tag),body));}
 @Post('requirement-sessions/:sessionId/turns/:turnId/cancel') @HttpCode(200)
 async cancel(@CurrentPrincipal() p:AuthenticatedPrincipal,@Param('sessionId') id:string,@Param('turnId') turnId:string,@Headers('idempotency-key') k:string|undefined,@Headers('if-match') tag:string|undefined,@Res({passthrough:true}) response:Response){return this.reply(response,await this.sessions.action(p.id,id,turnId,key(k),parseIfMatch(tag),'cancel'));}
 @Post('requirement-sessions/:sessionId/turns/:turnId/retry') @HttpCode(202)
 async retry(@CurrentPrincipal() p:AuthenticatedPrincipal,@Param('sessionId') id:string,@Param('turnId') turnId:string,@Headers('idempotency-key') k:string|undefined,@Headers('if-match') tag:string|undefined,@Res({passthrough:true}) response:Response){return this.reply(response,await this.sessions.action(p.id,id,turnId,key(k),parseIfMatch(tag),'retry'));}

 @Post('requirement-sessions/:sessionId/confirmations/:confirmationId/retry') @HttpCode(202)
 async retryConfirmation(@CurrentPrincipal() p:AuthenticatedPrincipal,@Param('sessionId') id:string,@Param('confirmationId') confirmationId:string,@Headers('idempotency-key') k:string|undefined,@Headers('if-match') tag:string|undefined,@Res({passthrough:true}) response:Response){return this.reply(response,await this.sessions.retryConfirmation(p.id,id,confirmationId,key(k),parseIfMatch(tag)));}
 private reply(response:Response,snapshot:{revision:number}){response.setHeader('ETag',revisionEtag(snapshot.revision));response.setHeader('Cache-Control','private, no-store');return snapshot;}
}
