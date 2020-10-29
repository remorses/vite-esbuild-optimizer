import React from 'react'
import merge from 'lodash-es/merge'
import {at} from 'smoldash'
at
export const SomeComponent = ({}) => {
    return (
        <pre>
            {JSON.stringify(merge({ merge: true }, { SomeComponent: true }))}
        </pre>
    )
}
