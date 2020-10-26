import { SomeComponent } from 'example-linked-package'
// axios is a commonjs package
import { merge } from 'lodash-es'
import React from 'react'
import merger from 'lodash-es/has'
merger
// import { merge as m } from 'lodash'
import Counter from './Counter/Counter'

import has from 'lodash/has'
has
import zip from 'lodash/zip'
zip


merge({}, {})
// m({}, {})

function App() {
    return (
        <div>
            <p>Example</p>
            <br />
            <br />
            <br />
            <Counter />
            <hr />
            <SomeComponent />
            <p>Some text</p>
        </div>
    )
}

export default App
