export default {
  type: 'output.log',
  label: 'Log',
  category: 'output',
  description: 'Writes a line to the run log.',
  outputs: ['main'],
  params: [
    { key: 'message', label: 'Message', type: 'text', default: '{{ $json }}',
      description: 'Written into the run log. Leave it as {{ $json }} to see everything the last step sent.' },
  ],
  run({ params, item, log }) {
    log(params.message)
    return [item]
  },
}
