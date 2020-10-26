import { addQuery } from '../src/optimizer'
import assert from 'assert'

it('addQuery', () => {
    var res = addQuery({ query: 'ciao', urlString: 'http://x.com' })
    assert.strictEqual(res, 'http://x.com/?ciao=')
    var res = addQuery({ query: 'ciao', urlString: 'http://x.com?x' })
    assert.strictEqual(res, 'http://x.com/?x=&ciao=')
})
