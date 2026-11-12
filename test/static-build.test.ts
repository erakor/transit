import { describe, expect, it } from 'vitest'
import { forEachCsvRow, parseCsv } from '#src/static/csv.js'
import { buildSubwayData } from '#src/static/build.js'
import { SUBWAY_DATA } from '#src/data/subway.generated.js'

const files = {
  'feed_info.txt': 'feed_publisher_name,feed_version\nMTA,v1\n',
  'routes.txt':
    'route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_color,route_text_color,route_sort_order\n' +
    '1,MTA,1,Broadway - 7 Avenue Local,"Trains operate ""local"", at all times",1,EE352E,,1\n' +
    'A,MTA,A,8 Avenue Express,,1,0062cf,FFFFFF,5\n' +
    'GS,MTA,S,42 St Shuttle,,1,,,9\n',
  'stops.txt':
    'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\r\n' +
    '127,Times Sq-42 St,40.75529,-73.987495,1,\r\n127N,Times Sq-42 St,40.75529,-73.987495,,127\r\n127S,Times Sq-42 St,40.75529,-73.987495,,127\r\n' +
    'A27,42 St-Port Authority Bus Terminal,40.757308,-73.989735,1,\r\nA27N,42 St-Port Authority Bus Terminal,40.757308,-73.989735,,A27\r\n' +
    '902,Times Sq-42 St,40.755983,-73.986229,1,\r\n902N,Times Sq-42 St,40.755983,-73.986229,,902\r\n' +
    '101,Van Cortlandt Park-242 St,40.889248,-73.898583,1,\r\n101S,Van Cortlandt Park-242 St,40.889248,-73.898583,,101\r\n',
  'trips.txt': 'route_id,trip_id,service_id\n1,t1,W\nA,t2,W\nGS,t3,W\n',
  'stop_times.txt':
    'trip_id,stop_id,arrival_time,departure_time,stop_sequence\n' +
    't1,101S,00:00:00,00:00:00,1\nt1,127S,00:20:00,00:20:00,2\nt2,A27N,00:00:00,00:00:00,1\nt3,902N,00:00:00,00:00:00,1\n',
  'transfers.txt':
    'from_stop_id,to_stop_id,transfer_type,min_transfer_time\n127,127,2,0\n127,A27,2,300\nA27,902,2,180\n101,101,2,0\n',
}

describe('csv', () => {
  it('handles quotes, escaped quotes, CRLF and BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, ""y""",z\n')).toEqual([
      ['a', 'b'],
      ['x, "y"', 'z'],
    ])
  })
  it('extracts columns row by row', () => {
    const rows: string[][] = []
    forEachCsvRow('b,a,c\n1,2,3\n"4,4",5,6\n', ['a', 'b'], v => rows.push(v))
    expect(rows).toEqual([
      ['2', '1'],
      ['5', '4,4'],
    ])
  })
})

describe('buildSubwayData', () => {
  const data = buildSubwayData(files)

  it('keeps parent stations with the routes that serve them', () => {
    expect(Object.keys(data.stops)).toEqual(['101', '127', '902', 'A27'])
    expect(data.stops['127']).toMatchObject({ name: 'Times Sq-42 St', routes: ['1'], lat: 40.75529 })
    expect(data.stops['101']!.routes).toEqual(['1'])
    expect(data.stops['902']!.routes).toEqual(['GS'])
  })

  it('normalizes route colors and names', () => {
    expect(data.routes['1']).toMatchObject({ color: '#EE352E', textColor: '#FFFFFF', sortOrder: 1 })
    expect(data.routes['A']!.color).toBe('#0062CF')
    expect(data.routes['GS']).toMatchObject({ shortName: 'S', color: '#808183' })
  })

  it('groups stops linked by transfers into one station', () => {
    const times = data.stations.find(s => s.stops.includes('127'))!
    expect(times).toMatchObject({
      id: '127+902+A27',
      name: 'Times Sq-42 St',
      stops: ['127', '902', 'A27'],
      routes: ['1', 'A', 'GS'],
    })
    expect(data.stops['A27']!.station).toBe('127+902+A27')
    expect(data.stations.find(s => s.id === '101')!.stops).toEqual(['101'])
  })

  it('reads the feed version and is deterministic', () => {
    expect(data.feedVersion).toBe('v1')
    expect(JSON.stringify(buildSubwayData(files))).toBe(JSON.stringify(data))
  })

  it('fails on a missing file', () => {
    expect(() => buildSubwayData({ ...files, 'stops.txt': undefined } as never)).toThrow(/stops.txt/)
  })
})

describe('committed static data', () => {
  it('looks like the real subway', () => {
    expect(Object.keys(SUBWAY_DATA.stops).length).toBeGreaterThan(400)
    expect(SUBWAY_DATA.routes['L']!.color).toMatch(/^#[0-9A-F]{6}$/)
    const times = SUBWAY_DATA.stations.find(s => s.stops.includes('127'))!
    expect(times.stops).toEqual(expect.arrayContaining(['127', '725', '902', 'R16']))
    for (const s of SUBWAY_DATA.stations) for (const id of s.stops) expect(SUBWAY_DATA.stops[id]!.station).toBe(s.id)
  })
})
