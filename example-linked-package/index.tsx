import React from 'react'
import merge from 'lodash/merge'
// import smol from 'smoldash'
// smol
// import isreg from 'lodash/isRegExp'
// isreg

export const SomeComponent = ({}) => {
    return (
        <pre>
            {JSON.stringify(merge({ merge: true }, { SomeComponent: true }))}
        </pre>
    )
}
