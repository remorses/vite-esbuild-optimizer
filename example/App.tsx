import React, { useState, useEffect } from 'react'
// axios is a commonjs package
import { merge } from 'lodash-es'
// import { merge as m } from 'lodash'
import Counter from './Counter'
// import {SomeComponent} from 'some-react-components'

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
            {/* <SomeComponent/> */}
            <p>Some text</p>
        </div>
    )
}

export default App
