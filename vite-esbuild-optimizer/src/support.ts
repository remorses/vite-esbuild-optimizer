import { EventEmitter, once } from 'events'

const queryRE = /\?.*$/
const hashRE = /#.*$/
const moduleRE = /^\/?@modules\//

const cleanUrl = (url: string) => {
    return url.replace(hashRE, '').replace(queryRE, '')
}

const sleep = (t) => new Promise((res) => setTimeout(res, t))

function getPackageNameFromImportPath(importPath: string) {
    const parts = importPath.replace(moduleRE, '').split('/')
    if (parts[0].startsWith('@')) {
        return parts.slice(0, 2).join('/')
    }
    return parts[0]
}

export function isUrl(req: string) {
    return req.startsWith('http://') || req.startsWith('https://')
}

export interface OptimizeAnalysisResult {
    // TODO import from vite
    isCommonjs: { [name: string]: true }
}

export class Mutex extends EventEmitter {
    READY_EVENT = 'READY_EVENT'
    isReady = false
    constructor() {
        super()
        this.once(this.READY_EVENT, () => {
            this.isReady = true
        })
    }
    ready() {
        this.emit(this.READY_EVENT)
    }
    wait(): Promise<any> {
        return once(this, this.READY_EVENT)
    }
}
