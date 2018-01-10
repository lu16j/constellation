function rendezvous(me, form, partner, status) {
  form.on('submit', function() {
    var mycode = me.trim().toLowerCase().split(/\s+/);
    var partnercode = partner.val().trim().toLowerCase().split(/\s+/);
    var url = mycode.toString() === partnercode.toString()
              ? document.location.pathname.replace('/pair/', '/single/')
              : document.location.pathname;
    console.log(mycode, partnercode, url);
    try {
      $.ajax({
        type: 'POST',
        url: url,
        data: JSON.stringify({
          me: mycode,
          partner: partnercode
        }),
        contentType: 'application/json'
      }).done(function(responseJSON) {
        status.text('Redirecting...');
        document.location.href = responseJSON.redirect;
      }).fail(function(req) {
        status.text(req.responseJSON && req.responseJSON.error || 'Error');
      });
      status.text('Waiting for partner...');
    } catch (e) {
      console && console.error && console.error(e);
    }
    return false;
  });
}
