import CodeBlockWriter from 'code-block-writer'
import { generateOperationId } from '@platformatic/client'
import { capitalize, getAllResponseCodes, getResponseContentType, getResponseTypes, is200JsonResponse } from './utils.mjs'
import camelcase from 'camelcase'
import { writeOperations } from '../../client-cli/lib/openapi-common.mjs'

export function processFrontendOpenAPI ({ schema, name, language, fullResponse }) {
  return {
    types: generateTypesFromOpenAPI({ schema, name, fullResponse }),
    implementation: generateFrontendImplementationFromOpenAPI({ schema, name, language, fullResponse })
  }
}

function generateFrontendImplementationFromOpenAPI ({ schema, name, language, fullResponse }) {
  const camelCaseName = capitalize(camelcase(name))
  const { paths } = schema
  const generatedOperationIds = []
  const operations = Object.entries(paths).flatMap(([path, methods]) => {
    return Object.entries(methods).map(([method, operation]) => {
      const opId = generateOperationId(path, method, operation, generatedOperationIds)
      return {
        path,
        method,
        operation: {
          ...operation,
          operationId: opId
        }
      }
    })
  })

  /* eslint-disable new-cap */
  const writer = new CodeBlockWriter({
    indentNumberOfSpaces: 2,
    useTabs: false,
    useSingleQuote: true
  })

  writer.write('// This client was generated by Platformatic from an OpenAPI specification.')
  writer.blankLine()

  writer.conditionalWriteLine(language === 'ts', `import type { ${camelCaseName} } from './${name}-types'`)
  writer.conditionalWriteLine(language === 'ts', `import type * as Types from './${name}-types'`)
  writer.blankLineIfLastNot()

  writer.writeLine('// The base URL for the API. This can be overridden by calling `setBaseUrl`.')
  writer.writeLine('let baseUrl = \'\'')
  if (language === 'ts') {
    writer.writeLine(
      'export const setBaseUrl = (newUrl: string) : void => { baseUrl = newUrl }'
    )

    writer.writeLine('/* @ts-ignore */')
    writer.write('function headersToJSON(headers: Headers): Object ').block(() => {
      writer.writeLine('const output = {} as any')
      writer.write('headers.forEach((value, key) => ').inlineBlock(() => {
        writer.write('output[key] = value')
      })
      writer.write(')')
      writer.writeLine('return output')
    })
  } else {
    writer.writeLine(
      `/**  @type {import('./${name}-types.d.ts').${camelCaseName}['setBaseUrl']} */`
    )
    writer.writeLine(
      'export const setBaseUrl = (newUrl) => { baseUrl = newUrl }'
    )

    writer.write('function headersToJSON(headers) ').block(() => {
      writer.writeLine('const output = {}')
      writer.write('headers.forEach((value, key) => ').inlineBlock(() => {
        writer.write('output[key] = value')
      })
      writer.write(')')
      writer.writeLine('return output')
    })
  }
  writer.blankLine()
  const allOperations = []
  const originalFullResponse = fullResponse
  let currentFullResponse = originalFullResponse
  function getQueryParamsString (operationParams) {
    return operationParams
      .filter((p) => p.in === 'query')
      .map((p) => p.name)
  }

  function getHeaderParams (operationParams) {
    return operationParams
      .filter((p) => p.in === 'header')
      .map((p) => p.name)
  }
  for (const operation of operations) {
    const { operationId, responses } = operation.operation
    const camelCaseOperationId = camelcase(operationId)
    const operationRequestName = `${capitalize(camelCaseOperationId)}Request`
    const operationResponseName = `${capitalize(camelCaseOperationId)}Responses`
    const underscoredOperationId = `_${operationId}`
    let queryParams = []
    let headerParams = []
    if (operation.operation.parameters) {
      queryParams = getQueryParamsString(operation.operation.parameters)
      headerParams = getHeaderParams(operation.operation.parameters)
    }
    allOperations.push(operationId)
    const { method, path } = operation

    // Only dealing with success responses
    const successResponses = Object.entries(responses).filter(([s]) => s.startsWith('2'))
    /* c8 ignore next 3 */
    if (successResponses.length !== 1) {
      currentFullResponse = true
    } else {
      // check if is empty response
      if (getResponseContentType(successResponses[0][1]) === null) {
        currentFullResponse = true
      }
    }
    if (language === 'ts') {
      // Write
      //
      // ```ts
      // export const getMovies:Api['getMovies'] = async (request) => {
      // ```
      writer.write(
        `const ${underscoredOperationId} = async (url: string, request: Types.${operationRequestName}): Promise<Types.${operationResponseName}> =>`
      )
    } else {
      writer.write(`async function ${underscoredOperationId} (url, request)`)
    }

    writer.block(() => {
      // Transform
      // /organizations/{orgId}/members/{memberId}
      // to
      // /organizations/${request.orgId}/members/${request.memberId}
      const stringLiteralPath = path.replace(/\{/gm, '${request[\'').replace(/\}/gm, '\']}')
      // GET methods need query strings instead of JSON bodies
      if (queryParams.length) {
        // query parameters should be appended to the url
        const quotedParams = queryParams.map((qp) => `'${qp}'`)
        let queryParametersType = ''
        if (language === 'ts') {
          queryParametersType = `: (keyof Types.${operationRequestName})[] `
        }
        writer.writeLine(`const queryParameters${queryParametersType} = [${quotedParams.join(', ')}]`)
        writer.writeLine('const searchParams = new URLSearchParams()')
        writer.write('queryParameters.forEach((qp) => ').inlineBlock(() => {
          writer.write('if (request[qp]) ').block(() => {
            writer.writeLine('searchParams.append(qp, request[qp]?.toString() || \'\')')
            writer.writeLine('delete request[qp]')
          })
        })
        writer.write(')')
        writer.blankLine()
      }
      if (method !== 'get') {
        writer.write('const headers =').block(() => {
          writer.writeLine('\'Content-type\': \'application/json; charset=utf-8\'')
        })
      }

      headerParams.forEach((param, idx) => {
        writer.write(`if (request['${param}'] !== undefined)`).block(() => {
          writer.writeLine(`headers['${param}'] = request['${param}']`)
          writer.writeLine(`delete request['${param}']`)
        })
      })
      writer.blankLine()

      /* eslint-disable-next-line no-template-curly-in-string */
      const searchString = queryParams.length > 0 ? '?${searchParams.toString()}' : ''
      if (method !== 'get') {
        writer
          .write(`const response = await fetch(\`\${url}${stringLiteralPath}${searchString}\`, `)
          .inlineBlock(() => {
            writer.write('method: ').quote().write(method.toUpperCase()).quote().write(',')
            writer.writeLine('body: JSON.stringify(request),')
            writer.write('headers')
          })
          .write(')')
      } else {
        writer.write(`const response = await fetch(\`\${url}${stringLiteralPath}${searchString}\`)`)
      }

      writer.blankLine()
      const mappedResponses = getResponseTypes(operation.operation.responses)
      if (currentFullResponse) {
        const allResponseCodes = getAllResponseCodes(operation.operation.responses)
        Object.keys(mappedResponses).forEach((responseType) => {
          if (mappedResponses[responseType].length > 0) {
            writer.writeLine(`const ${responseType}Responses = [${mappedResponses[responseType].join(', ')}]`)
            writer.write(`if (${responseType}Responses.includes(response.status)) `).block(() => {
              writer.write('return ').block(() => {
                writer.write('statusCode: response.status')
                if (language === 'ts') {
                  writer.write(` as ${mappedResponses[responseType].join(' | ')},`)
                } else {
                  writer.write(',')
                }
                writer.writeLine('headers: headersToJSON(response.headers),')
                writer.writeLine(`body: await response.${responseType}()`)
              })
            })
          }
        })

        // write default response as fallback
        writer.write('if (response.headers.get(\'content-type\') === \'application/json\') ').block(() => {
          writer.write('return ').block(() => {
            writer.write('statusCode: response.status')
            if (language === 'ts') {
              writer.write(` as ${allResponseCodes.join(' | ')},`)
            } else {
              writer.write(',')
            }
            writer.writeLine('headers: headersToJSON(response.headers),')
            writer.write('body: await response.json()')
            if (language === 'ts') {
              writer.write(' as any')
            }
          })
        })
        writer.write('return ').block(() => {
          writer.write('statusCode: response.status')
          if (language === 'ts') {
            writer.write(` as ${allResponseCodes.join(' | ')},`)
          } else {
            writer.write(',')
          }
          writer.writeLine('headers: headersToJSON(response.headers),')
          writer.write('body: await response.text()')
          if (language === 'ts') {
            writer.write(' as any')
          }
        })
      } else {
        writer.write('if (!response.ok)').block(() => {
          writer.writeLine('throw new Error(await response.text())')
        })

        writer.blankLine()
        if (is200JsonResponse(operation.operation.responses)) {
          writer.writeLine('return await response.json()')
        } else {
          writer.writeLine('return await response.text()')
        }
      }
    })
    writer.blankLine()
    if (language === 'ts') {
      writer.write(`export const ${operationId}: ${camelCaseName}['${operationId}'] = async (request: Types.${operationRequestName}): Promise<Types.${operationResponseName}> =>`).block(() => {
        writer.write(`return await ${underscoredOperationId}(baseUrl, request)`)
      })
    } else {
      // The JS version uses the JSDoc type format to offer IntelliSense autocompletion to the developer.
      //
      // ```js
      // /** @type {import('./api-types.d.ts').Api['getMovies']} */
      // export const getMovies = async (request) => {
      // ```
      //
      writer
        .writeLine(
          `/**  @type {import('./${name}-types.d.ts').${camelCaseName}['${operationId}']} */`
        )
        .write(`export const ${operationId} = async (request) =>`).block(() => {
          writer.write(`return await ${underscoredOperationId}(baseUrl, request)`)
        })
    }
    currentFullResponse = originalFullResponse
  }
  // create factory
  const factoryBuildFunction = language === 'ts'
    ? 'export default function build (url: string)'
    : 'export default function build (url)'
  writer.write(factoryBuildFunction).block(() => {
    writer.write('return').block(() => {
      for (const [idx, op] of allOperations.entries()) {
        const underscoredOperation = `_${op}`
        const methodString = `${op}: ${underscoredOperation}.bind(url, ...arguments)`
        if (idx === allOperations.length - 1) {
          writer.writeLine(`${methodString}`)
        } else {
          writer.writeLine(`${methodString},`)
        }
      }
    })
  })
  return writer.toString()
}

function generateTypesFromOpenAPI ({ schema, name, fullResponse }) {
  const camelCaseName = capitalize(camelcase(name))
  const { paths } = schema
  const generatedOperationIds = []
  const operations = Object.entries(paths).flatMap(([path, methods]) => {
    return Object.entries(methods).map(([method, operation]) => {
      const opId = generateOperationId(path, method, operation, generatedOperationIds)
      return {
        path,
        method,
        operation: {
          ...operation,
          operationId: opId
        }
      }
    })
  })
  /* eslint-disable new-cap */
  const writer = new CodeBlockWriter({
    indentNumberOfSpaces: 2,
    useTabs: false,
    useSingleQuote: true
  })

  const interfaces = new CodeBlockWriter({
    indentNumberOfSpaces: 2,
    useTabs: false,
    useSingleQuote: true
  })
  /* eslint-enable new-cap */
  interfaces.write('export interface FullResponse<T, U extends number>').block(() => {
    interfaces.writeLine('\'statusCode\': U;')
    interfaces.writeLine('\'headers\': object;')
    interfaces.writeLine('\'body\': T;')
  })
  interfaces.blankLine()

  writer.blankLine()
  writer.write(`export interface ${camelCaseName}`).block(() => {
    writer.writeLine('setBaseUrl(newUrl: string) : void;')
    writeOperations(interfaces, writer, operations, {
      fullRequest: false, fullResponse, optionalHeaders: [], schema
    })
  })

  writer.writeLine(`type PlatformaticFrontendClient = Omit<${capitalize(name)}, 'setBaseUrl'>`)
  writer.writeLine('export default function build(url: string): PlatformaticFrontendClient')
  return interfaces.toString() + writer.toString()
}
