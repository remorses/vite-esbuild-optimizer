import { SomeComponent } from 'example-linked-package'
// axios is a commonjs package
import { merge } from 'lodash-es'
import React, { useState } from 'react'
import merger from 'lodash-es/has'
merger
import('lodash-es/has')
import Counter from './Counter/Counter'
merge
import has from 'lodash/has'
has
// import zip from 'lodash/zip'
// zip
console.log(new Error('hello'))

merge({}, {})

// m({}, {})

function App() {
    const [hello] = useState('hello')
    return (
        <div>
            <p>Example</p>
            <br />
            {hello}
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
