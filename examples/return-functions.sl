; scratchpiler/examples/return-functions.sdsl, as irgen would produce it before legalization.
; Note `%1`..`%3` in the flag script: two calls feed one `add`, so the second call clobbers
; @__ret_rectArea before the first result is read. spill keeps exactly that one value in a temp,
; where lower.js today makes a temp for every call result.

stage {
  var @area
  var @msg
}

sprite "Sprite1" {
  proc @rectArea(w, h) warp returns {
    %0 = arg w
    %1 = arg h
    %2 = mul %0, %1
    ret %2
  }

  proc @fact(n) warp returns {
    %0 = arg n
    %1 = lt %0, 2
    if %1 {
      ret 1
    }
    %2 = sub %0, 1
    %3 = call @fact(%2)
    %4 = mul %0, %3
    ret %4
  }

  proc @greet(who) warp returns {
    %0 = arg who
    %1 = join "hello, ", %0
    ret %1
  }

  script flag {
    %0 = call @rectArea(6, 7)
    var.set @area, %0
    %1 = call @rectArea(3, 4)
    %2 = call @rectArea(2, 5)
    %3 = add %1, %2
    %4 = eq %3, 22
    if %4 {
      sb looks_sayforsecs(MESSAGE: "arithmetic checks out", SECS: 2)
    }
  }
}
