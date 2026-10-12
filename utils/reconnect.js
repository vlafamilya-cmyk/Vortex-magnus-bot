class ReconnectManager {
 constructor({connect,logger,baseMs=2000,maxMs=60000,random=Math.random}) { this.connect=connect; this.logger=logger; this.baseMs=baseMs; this.maxMs=maxMs; this.random=random; this.timer=null; this.stopped=true; this.attempts=0; this.running=false; }
 schedule() { if(this.stopped||this.timer||this.running) return false; const cap=Math.min(this.maxMs,this.baseMs*2**Math.min(this.attempts,10)); const delay=Math.floor(cap*(0.8+this.random()*0.4)); this.attempts++; this.logger?.warn?.('RECONNECT_SCHEDULED',{attempt:this.attempts,delayMs:delay}); this.timer=setTimeout(async()=>{this.timer=null;if(this.stopped)return;this.running=true;try{await this.connect();this.attempts=0;}catch(e){this.logger?.error?.('RECONNECT_FAILED',{error:e.message});}finally{this.running=false;if(!this.stopped)this.schedule();}},delay); this.timer.unref?.(); return true; }
 start(){this.stopped=false;} stop(){this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=null;} reset(){this.attempts=0;}
}
module.exports={ReconnectManager};
