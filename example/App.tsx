import { SomeComponent } from 'example-linked-package'
// axios is a commonjs package
import { merge } from 'lodash-es'
import React from 'react'
import merger from 'lodash-es/merge'
merger
// import { merge as m } from 'lodash'
import Counter from './Counter/Counter'



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
